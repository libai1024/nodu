// SPDX-License-Identifier: MIT
// Ported from openmv-qt-creator openmvpluginfb.cpp + tools/videotools.cpp (MIT)
// and MaixPy-v1 py_image.c (MIT).
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/openmvpluginfb.cpp
//   (beginImageWriter/private_timerCallBack: "OMV IMG STR V1.0" magic,
//   LE i32 [ms,w,h,jpegLen] + payload + 16B pad)
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/tools/videotools.cpp
//   (getMaxSizeAndAvgMsDelta running average, per-frame transcode,
//   bundled-ffmpeg shell-out)
// Source: sipeed/MaixPy-v1 d8901fd2272f000226f1c1037c1eb7c412b88e66 components/micropython/port/src/omv/py/py_image.c
//   (ImageWriter stream semantics; K210 framebuffer frames are JPEG payloads)
//! OpenMV ImageWriter `.bin` recording plus bundled-ffmpeg transcode/playback.
//!
//! Format: 16-byte magic, then per frame LE u32 `[ms_delta, w, h, len]`, the
//! payload, and `(16 - len % 16) % 16` zero bytes. This tranche supports only
//! JPEG payload streams (the `len` field > 3): bpp 0..=3 raw image streams
//! are rejected explicitly instead of being silently misdecoded.
//! The conversion deliberately emits a smoothed constant frame rate exactly
//! like the original IDE (`avg = (avg + delta) / 2`); variable per-frame
//! intervals are not preserved.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use nodu_repl::{Check, ReplError};

/// ImageWriter stream magic written by the original framebuffer recorder.
pub const MAGIC: &[u8; 16] = b"OMV IMG STR V1.0";

const MAX_DIM: u32 = 2048;
const MAX_AREA: u64 = 1_048_576;
const MIN_JPEG: usize = 4;
const MAX_JPEG: usize = 2 * 1024 * 1024;
const MAX_STREAM_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_STREAM_DELTA_MS: u64 = 86_400_000;
const MAX_FRAMES: u64 = 10_000;
const STDERR_TAIL: usize = 64 * 1024;

fn err(message: impl Into<String>) -> ReplError {
    ReplError::device(message)
}

fn io_err(e: std::io::Error) -> ReplError {
    err(format!("Recording I/O failed: {e}"))
}

/// Public counters for a recording in progress or just finished.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSummary {
    pub path: String,
    pub frames: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

/// Streams validated JPEG frames into an ImageWriter `.bin` file. The raw
/// file always remains on disk after failures so partial footage is
/// recoverable; the target is never overwritten (`create_new`).
#[derive(Debug)]
pub struct Recorder {
    file: BufWriter<File>,
    path: PathBuf,
    started: Instant,
    last: Instant,
    frames: u64,
    bytes: u64,
}

impl Recorder {
    /// Create a new `.bin` recording at an absolute path; refuses to
    /// overwrite anything and writes the 16-byte magic up front.
    pub fn create(path: &Path) -> Result<Self, ReplError> {
        let is_bin = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("bin"));
        if !path.is_absolute() || !is_bin {
            return Err(err("Recording target must be an absolute .bin path."));
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| err(format!("Cannot create recording file: {e}")))?;
        let mut file = BufWriter::new(file);
        file.write_all(MAGIC).map_err(io_err)?;
        let now = Instant::now();
        Ok(Self {
            file,
            path: path.to_path_buf(),
            started: now,
            last: now,
            frames: 0,
            bytes: MAGIC.len() as u64,
        })
    }

    /// Append one validated frame; returns the updated counters.
    pub fn append(
        &mut self,
        width: u32,
        height: u32,
        jpeg: &[u8],
    ) -> Result<RecordingSummary, ReplError> {
        if self.frames >= MAX_FRAMES {
            return Err(err("Recording exceeds the 10000 frame limit."));
        }
        validate_frame(width, height, jpeg)?;
        let pad = (16 - jpeg.len() % 16) % 16;
        let needed = 16 + jpeg.len() as u64 + pad as u64;
        if self.bytes + needed > MAX_STREAM_BYTES {
            return Err(err("Recording exceeds the 2 GiB limit."));
        }
        let now = Instant::now();
        let delta = (now - self.last)
            .as_millis()
            .clamp(1, u128::from(u32::MAX))
            .min(u128::from(MAX_STREAM_DELTA_MS)) as u32;
        self.last = now;
        for v in [delta, width, height, jpeg.len() as u32] {
            self.file.write_all(&v.to_le_bytes()).map_err(io_err)?;
        }
        self.file.write_all(jpeg).map_err(io_err)?;
        if pad > 0 {
            self.file.write_all(&[0u8; 16][..pad]).map_err(io_err)?;
        }
        self.frames += 1;
        self.bytes += needed;
        Ok(self.summary())
    }

    /// Flush + fsync, then return the final counters. I/O failure is never
    /// reported as success; the raw file stays in place for recovery.
    pub fn finish(mut self) -> Result<RecordingSummary, ReplError> {
        self.file.flush().map_err(io_err)?;
        self.file.get_ref().sync_all().map_err(io_err)?;
        Ok(self.summary())
    }

    pub fn summary(&self) -> RecordingSummary {
        RecordingSummary {
            path: self.path.to_string_lossy().into_owned(),
            frames: self.frames,
            bytes: self.bytes,
            elapsed_ms: self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        }
    }
}

fn validate_frame(width: u32, height: u32, jpeg: &[u8]) -> Result<(), ReplError> {
    if width == 0 || width > MAX_DIM || height == 0 || height > MAX_DIM {
        return Err(err("Frame dimensions are out of range."));
    }
    if u64::from(width) * u64::from(height) > MAX_AREA {
        return Err(err("Frame dimensions exceed the area limit."));
    }
    if !(MIN_JPEG..=MAX_JPEG).contains(&jpeg.len()) {
        return Err(err("Frame JPEG is empty or exceeds the 2 MiB limit."));
    }
    if !jpeg.starts_with(&[0xff, 0xd8]) || !jpeg.ends_with(&[0xff, 0xd9]) {
        return Err(err("Frame payload is not a complete JPEG image."));
    }
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(jpeg));
    let info = (decoder.read_info().ok()).and_then(|()| decoder.info());
    let Some(info) = info else {
        return Err(err("Frame JPEG header could not be decoded."));
    };
    if u32::from(info.width) != width || u32::from(info.height) != height {
        return Err(err("Frame JPEG dimensions do not match the frame header."));
    }
    Ok(())
}

/// Streaming ImageWriter reader: validates every record and hands each
/// `(ms_delta, width, height, payload)` to `on_frame` without holding the
/// whole stream in memory. Clean EOF only counts at a frame boundary;
/// truncated headers, payloads, or padding are errors. An empty stream
/// (magic only) is valid here; conversion additionally requires >= 1 frame.
pub fn read_stream<R: Read>(
    reader: &mut R,
    check: &Check,
    mut on_frame: impl FnMut(u32, u32, u32, &[u8]) -> Result<(), ReplError>,
) -> Result<(), ReplError> {
    let mut magic = [0u8; 16];
    match reader.read_exact(&mut magic) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(err("Recording stream is truncated before the magic."));
        }
        Err(e) => return Err(io_err(e)),
    }
    if magic != *MAGIC {
        return Err(err("Not an OpenMV image stream (bad magic)."));
    }
    let mut total: u64 = 16;
    loop {
        check()?;
        // Frame headers must arrive whole: 0 bytes at a boundary is a clean
        // end, 1..15 is truncation.
        let mut header = [0u8; 16];
        let mut filled = 0usize;
        while filled < header.len() {
            match reader.read(&mut header[filled..]) {
                Ok(0) if filled == 0 => return Ok(()),
                Ok(0) => return Err(err("Recording stream has a truncated frame header.")),
                Ok(n) => {
                    filled += n;
                    total += n as u64;
                }
                Err(e) => return Err(io_err(e)),
            }
        }
        // `header` is a fixed [u8; 16] by construction; the slices cannot fail.
        let m = u32::from_le_bytes(header[0..4].try_into().expect("16-byte header"));
        let w = u32::from_le_bytes(header[4..8].try_into().expect("16-byte header"));
        let h = u32::from_le_bytes(header[8..12].try_into().expect("16-byte header"));
        let len = u32::from_le_bytes(header[12..16].try_into().expect("16-byte header"));
        if m == 0
            || u64::from(m) > MAX_STREAM_DELTA_MS
            || w == 0
            || w > MAX_DIM
            || h == 0
            || h > MAX_DIM
            || u64::from(w) * u64::from(h) > MAX_AREA
        {
            return Err(err("Recording stream frame header is out of sane limits."));
        }
        // The original writer stores raw bpp 0..=3 here; JPEG frames store
        // the payload byte length instead. Raw streams are out of scope.
        if len <= 3 {
            return Err(err(
                "Raw (non-JPEG) image streams are not supported by this build.",
            ));
        }
        let len = len as usize;
        if !(MIN_JPEG..=MAX_JPEG).contains(&len) {
            return Err(err("Recording stream frame length is out of sane limits."));
        }
        let pad = (16 - len % 16) % 16;
        total += len as u64 + pad as u64;
        if total > MAX_STREAM_BYTES {
            return Err(err("Recording stream exceeds the 2 GiB limit."));
        }
        let mut data = vec![0u8; len];
        reader
            .read_exact(&mut data)
            .map_err(|_| err("Recording stream has a truncated frame payload."))?;
        if pad > 0 {
            // The original reader only skips the padding; contents are
            // ignored, not validated.
            let mut skip = [0u8; 16];
            reader
                .read_exact(&mut skip[..pad])
                .map_err(|_| err("Recording stream has truncated frame padding."))?;
        }
        // A frame is validated exactly like a recorded one before the
        // callback sees it: corrupt payloads never reach consumers.
        validate_frame(w, h, &data)?;
        on_frame(m, w, h, &data)?;
    }
}

fn tool(tools: &Path, name: &str) -> Result<PathBuf, ReplError> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let path = tools.join(exe);
    if path.is_file() {
        Ok(path)
    } else {
        Err(err(format!(
            "Bundled {name} is unavailable; run the media bundle build first."
        )))
    }
}

fn canonical_input(input: &Path) -> Result<PathBuf, ReplError> {
    let path =
        fs::canonicalize(input).map_err(|e| err(format!("Input video is unreadable: {e}")))?;
    let meta = fs::metadata(&path).map_err(|e| err(format!("Input video is unreadable: {e}")))?;
    if !meta.is_file() {
        return Err(err("Input video must be a regular file."));
    }
    if meta.len() > MAX_STREAM_BYTES {
        return Err(err("Input video exceeds the 2 GiB limit."));
    }
    Ok(path)
}

fn is_stream_file(path: &Path) -> Result<bool, ReplError> {
    let mut file = File::open(path).map_err(|e| err(format!("Input video is unreadable: {e}")))?;
    let mut magic = [0u8; 16];
    match file.read_exact(&mut magic) {
        Ok(()) => Ok(magic == *MAGIC),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(io_err(e)),
    }
}

/// Convert `input` (a `.bin` ImageWriter stream or a regular video file)
/// into `output` (`.mp4`/`.avi`/`.mjpeg`, must not exist) using only the
/// bundled ffmpeg. All output goes to an owned temp file in the output
/// directory (`-y` applies to that temp only) and is persisted with
/// `persist_noclobber`; the user's output and input are never overwritten.
pub fn convert(input: &Path, output: &Path, tools: &Path, check: &Check) -> Result<(), ReplError> {
    check()?;
    let input = canonical_input(input)?;
    let ffmpeg = tool(tools, "ffmpeg")?;
    if !output.is_absolute() {
        return Err(err("Output must be an absolute path."));
    }
    let ext = output
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "mp4" | "avi" | "mjpeg") {
        return Err(err("Output must end in .mp4, .avi, or .mjpeg."));
    }
    if output.exists() {
        return Err(err("Output already exists; refusing to overwrite."));
    }
    let parent = output
        .parent()
        .ok_or_else(|| err("Output must name a file inside a directory."))?;
    let temp = tempfile::Builder::new()
        .suffix(&format!(".{ext}"))
        .tempfile_in(parent)
        .map_err(|e| err(format!("Cannot create a temporary output: {e}")))?;
    let temp_path = temp.path().to_path_buf();

    let mut args: Vec<OsString> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    // Keep the extraction directory alive until ffmpeg has consumed it.
    let _frames_dir = if is_stream_file(&input)? {
        let dir = tempfile::Builder::new()
            .prefix("nodu-frames-")
            .tempdir()
            .map_err(|e| err(format!("Cannot create a frame workspace: {e}")))?;
        let stats = extract_frames(&input, dir.path(), check)?;
        if stats.frames == 0 {
            return Err(err("Recording contains no frames."));
        }
        args.push("-framerate".into());
        args.push(format!("{}", 1000.0 / (stats.avg_ms.max(1) as f64)).into());
        args.push("-i".into());
        args.push(dir.path().join("frame-%06d.jpg").into_os_string());
        args.push("-vf".into());
        args.push(format!(
            "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
            stats.width, stats.height, stats.width, stats.height
        ).into());
        Some(dir)
    } else {
        args.push("-i".into());
        args.push(input.into_os_string());
        None
    };
    match ext.as_str() {
        "mjpeg" => args.extend([
            "-c:v".into(),
            "mjpeg".into(),
            "-f".into(),
            "mjpeg".into(),
            "-an".into(),
        ]),
        _ => args.extend([
            "-c:v".into(),
            "mpeg4".into(),
            "-q:v".into(),
            "3".into(),
            "-an".into(),
        ]),
    }
    args.push(temp_path.as_os_str().to_os_string());

    run_tool(&ffmpeg, &args, check)?;
    // A cancellation landing between the child finishing and the publish
    // still must not claim success; the temp file cleans itself up.
    check()?;
    temp.persist_noclobber(output)
        .map_err(|_| err("Output appeared during conversion; refusing to overwrite."))?;
    Ok(())
}

/// Play `input` with the bundled ffplay; `.bin` streams are converted to a
/// private temp MP4 first and the workspace outlives the player.
pub fn play(input: &Path, tools: &Path, check: &Check) -> Result<(), ReplError> {
    check()?;
    let input = canonical_input(input)?;
    let ffplay = tool(tools, "ffplay")?;
    let (_temp_dir, file) = if is_stream_file(&input)? {
        let dir = tempfile::Builder::new()
            .prefix("nodu-play-")
            .tempdir()
            .map_err(|e| err(format!("Cannot create a playback workspace: {e}")))?;
        let mp4 = dir.path().join("play.mp4");
        convert(&input, &mp4, tools, check)?;
        (Some(dir), mp4)
    } else {
        (None, input)
    };
    run_tool(
        &ffplay,
        &[
            OsString::from("-autoexit"),
            OsString::from("-loglevel"),
            OsString::from("error"),
            file.into_os_string(),
        ],
        check,
    )
}

#[derive(Debug, Default)]
struct FrameStats {
    frames: u64,
    bytes: u64,
    avg_ms: u64,
    width: u32,
    height: u32,
}

/// Extract JPEG frames to `frame-000000.jpg`… and accumulate the original
/// IDE's smoothed average delta (first delta, then `(avg + delta) / 2`)
/// plus even-rounded max dimensions.
fn extract_frames(input: &Path, dir: &Path, check: &Check) -> Result<FrameStats, ReplError> {
    let mut file = File::open(input).map_err(|e| err(format!("Input video is unreadable: {e}")))?;
    let mut stats = FrameStats::default();
    read_stream(&mut file, check, |m, w, h, data| {
        if stats.frames >= MAX_FRAMES {
            return Err(err("Recording exceeds the 10000 frame limit."));
        }
        stats.bytes += data.len() as u64;
        if stats.bytes > MAX_STREAM_BYTES {
            return Err(err("Extracted frames exceed the 2 GiB workspace limit."));
        }
        stats.avg_ms = if stats.frames == 0 {
            u64::from(m)
        } else {
            stats.avg_ms.midpoint(u64::from(m))
        };
        stats.width = stats.width.max(w).div_ceil(2) * 2;
        stats.height = stats.height.max(h).div_ceil(2) * 2;
        let path = dir.join(format!("frame-{:06}.jpg", stats.frames));
        fs::write(&path, data).map_err(|e| err(format!("Cannot write a frame image: {e}")))?;
        stats.frames += 1;
        Ok(())
    })?;
    Ok(stats)
}

/// Spawn `program args` with stdin/stdout silenced and stderr drained on a
/// reader thread into a bounded 64 KiB tail. Polls `check()` + `try_wait`
/// every 50 ms; on cancellation the child is killed, reaped, and the
/// reader joined before the original error is returned.
fn run_tool(program: &Path, args: &[OsString], check: &Check) -> Result<(), ReplError> {
    // Honour a pre-cancelled request before anything is spawned.
    check()?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| err(format!("Cannot launch {}: {e}", program.display())))?;
    let stderr = child.stderr.take();
    let reader = thread::spawn(move || -> String {
        let mut tail: Vec<u8> = Vec::new();
        if let Some(mut pipe) = stderr {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        tail.extend_from_slice(&buf[..n]);
                        if tail.len() > STDERR_TAIL {
                            let cut = tail.len() - STDERR_TAIL;
                            tail.drain(..cut);
                        }
                    }
                }
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let status = loop {
        if let Err(e) = check() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(e);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(err(format!("Media tool wait failed: {e}")));
            }
        }
    };
    let tail = reader.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let detail = tail.trim();
        Err(err(format!(
            "{} exited with {status}{}.",
            program
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("media tool"),
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodu_repl::never_cancel;

    /// Deterministic 4x4 JPEG shared with the IDE frame tests.
    fn jpeg() -> Vec<u8> {
        include_bytes!("../../nodu-maix-ide/tests/fixtures/frame-4x4.jpg").to_vec()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nodu-media-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recorder_writes_exact_format_and_padding() {
        let dir = temp_dir("format");
        let path = dir.join("rec.bin");
        let mut rec = Recorder::create(&path).unwrap();
        let summary = rec.append(4, 4, &jpeg()).unwrap();
        assert_eq!(summary.frames, 1);
        rec.append(4, 4, &jpeg()).unwrap();
        let done = rec.finish().unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..16], MAGIC);
        let jpeg_len = jpeg().len();
        let record = 16 + jpeg_len + (16 - jpeg_len % 16) % 16;
        assert_eq!(bytes.len(), 16 + 2 * record);
        assert_eq!(done.bytes as usize, bytes.len());
        // Second frame header sits right after the first padded record.
        let at = 16 + record;
        let w = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap());
        assert_eq!(w, 4);
        // Padding is zero-filled.
        let pad = (16 - jpeg_len % 16) % 16;
        assert!(bytes[at - pad..at].iter().all(|&b| b == 0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_refuses_overwrite_and_validates_frames() {
        let dir = temp_dir("guard");
        let path = dir.join("rec.bin");
        fs::write(&path, b"keep me").unwrap();
        assert!(
            Recorder::create(&path).is_err(),
            "existing file must survive"
        );
        assert_eq!(fs::read(&path).unwrap(), b"keep me");
        assert!(Recorder::create(Path::new("relative.bin")).is_err());
        assert!(Recorder::create(&dir.join("rec.mp4")).is_err());
        let path2 = dir.join("rec2.bin");
        let mut rec = Recorder::create(&path2).unwrap();
        assert!(rec.append(0, 4, &jpeg()).is_err());
        assert!(rec.append(4096, 4, &jpeg()).is_err());
        assert!(rec.append(4, 4, b"no-jpeg").is_err());
        assert!(rec.append(8, 8, &jpeg()).is_err(), "dims must match JPEG");
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_stream(frames: &[(u32, u32, u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = MAGIC.to_vec();
        for (m, w, h, data) in frames {
            for v in [*m, *w, *h, data.len() as u32] {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.extend_from_slice(data);
            out.resize(out.len() + (16 - data.len() % 16) % 16, 0);
        }
        out
    }

    #[test]
    fn read_stream_round_trips() {
        let data = write_stream(&[(33, 4, 4, jpeg()), (40, 4, 4, jpeg())]);
        let mut seen: Vec<(u32, u32, u32, usize)> = Vec::new();
        let mut cursor = std::io::Cursor::new(data);
        read_stream(&mut cursor, &never_cancel(), |m, w, h, d| {
            assert_eq!(d, jpeg().as_slice());
            seen.push((m, w, h, d.len()));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            seen,
            vec![(33, 4, 4, jpeg().len()), (40, 4, 4, jpeg().len())]
        );
    }

    #[test]
    fn read_stream_empty_is_ok() {
        let mut cursor = std::io::Cursor::new(MAGIC.to_vec());
        let mut seen = 0;
        read_stream(&mut cursor, &never_cancel(), |_, _, _, _| {
            seen += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, 0);
    }

    #[test]
    fn read_stream_rejects_corruption_before_callbacks() {
        let good = write_stream(&[(33, 4, 4, jpeg())]);
        // Wrong magic.
        let mut bad = good.clone();
        bad[0] = b'X';
        assert!(
            read_stream(
                &mut std::io::Cursor::new(bad),
                &never_cancel(),
                |_, _, _, _| Ok(())
            )
            .is_err()
        );
        // Truncated magic / header / payload / padding.
        for cut in [4, 20, 24, good.len() - 3, good.len() - 1] {
            let mut c = std::io::Cursor::new(good[..cut].to_vec());
            assert!(
                read_stream(&mut c, &never_cancel(), |_, _, _, _| Ok(())).is_err(),
                "cut at {cut} must fail"
            );
        }
        // Oversized width and oversized declared length fail pre-alloc.
        let mut wide = good.clone();
        wide[16 + 4..16 + 8].copy_from_slice(&65536u32.to_le_bytes());
        assert!(
            read_stream(
                &mut std::io::Cursor::new(wide),
                &never_cancel(),
                |_, _, _, _| Ok(())
            )
            .is_err()
        );
        let mut huge = good.clone();
        huge[16 + 12..16 + 16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(
            read_stream(
                &mut std::io::Cursor::new(huge),
                &never_cancel(),
                |_, _, _, _| Ok(())
            )
            .is_err()
        );
        // Raw bpp 0..=3 is an explicit unsupported error, never decoded.
        for bpp in 0u32..=3 {
            let mut raw = good.clone();
            raw[16 + 12..16 + 16].copy_from_slice(&bpp.to_le_bytes());
            let e = read_stream(
                &mut std::io::Cursor::new(raw),
                &never_cancel(),
                |_, _, _, _| Ok(()),
            )
            .unwrap_err();
            assert!(e.to_string().contains("not supported"), "{e}");
        }
    }

    #[test]
    fn read_stream_validates_jpeg_before_callbacks() {
        // Every invalid-payload variant must fail before a single callback.
        let cases: Vec<Vec<u8>> = vec![
            // SOI/EOI present but the interior is not a JPEG stream.
            {
                let mut j = jpeg();
                j.truncate(4);
                j.extend_from_slice(&[0xde, 0xad]);
                j.extend_from_slice(&[0xff, 0xd9]);
                j
            },
            // Missing SOI/EOI markers entirely.
            vec![0x11; 64],
            // Valid 4x4 JPEG whose header claims 8x8 (dims mismatch).
            jpeg(),
        ];
        let header_dims: [(u32, u32); 3] = [(4, 4), (4, 4), (8, 8)];
        for (payload, (w, h)) in cases.into_iter().zip(header_dims) {
            let data = write_stream(&[(33, w, h, payload)]);
            let mut calls = 0;
            let result = read_stream(
                &mut std::io::Cursor::new(data),
                &never_cancel(),
                |_, _, _, _| {
                    calls += 1;
                    Ok(())
                },
            );
            assert!(result.is_err(), "invalid payload must be rejected");
            assert_eq!(calls, 0, "callback must never see a bad frame");
        }
        // The stream limits match the recorder limits: 3000x3000 exceeds
        // both MAX_DIM and the area cap even though the payload is fine.
        let data = write_stream(&[(33, 3000, 4, jpeg())]);
        let mut calls = 0;
        assert!(
            read_stream(
                &mut std::io::Cursor::new(data),
                &never_cancel(),
                |_, _, _, _| {
                    calls += 1;
                    Ok(())
                }
            )
            .is_err()
        );
        assert_eq!(calls, 0);
    }

    #[test]
    fn recorder_enforces_the_frame_cap() {
        let dir = temp_dir("cap");
        let path = dir.join("rec.bin");
        let mut rec = Recorder::create(&path).unwrap();
        rec.frames = MAX_FRAMES;
        let e = rec.append(4, 4, &jpeg()).unwrap_err();
        assert!(e.to_string().contains("frame limit"), "{e}");
        // The partial file stays flushable and recoverable.
        rec.finish().unwrap();
        assert_eq!(&fs::read(&path).unwrap()[..16], MAGIC);
        let _ = fs::remove_dir_all(&dir);
    }

    fn bundled_tools() -> Option<PathBuf> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scope-extension/resources/bin")
            .join(format!(
                "{}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
        (dir.join("ffmpeg").is_file() && dir.join("ffprobe").is_file()).then_some(dir)
    }

    #[test]
    fn convert_bin_to_mp4_with_bundled_tools() {
        let Some(tools) = bundled_tools() else {
            eprintln!("skipping: bundled ffmpeg/ffprobe not staged");
            return;
        };
        let dir = temp_dir("convert");
        let input = dir.join("clip.bin");
        let output = dir.join("clip.mp4");
        {
            let mut rec = Recorder::create(&input).unwrap();
            rec.append(4, 4, &jpeg()).unwrap();
            std::thread::sleep(Duration::from_millis(5));
            rec.append(4, 4, &jpeg()).unwrap();
            rec.finish().unwrap();
        }
        convert(&input, &output, &tools, &never_cancel()).unwrap();
        assert!(output.is_file());
        // ffprobe agrees it is a 4x4 (even-rounded) video stream.
        let probe = Command::new(tools.join("ffprobe"))
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,codec_name",
                "-of",
                "csv=p=0",
            ])
            .arg(&output)
            .output()
            .unwrap();
        assert!(probe.status.success());
        let text = String::from_utf8_lossy(&probe.stdout);
        assert!(text.contains("mpeg4"), "{text}");
        assert!(text.contains("4,4"), "{text}");
        // Existing output is refused and untouched.
        let before = fs::read(&output).unwrap();
        assert!(convert(&input, &output, &tools, &never_cancel()).is_err());
        assert_eq!(fs::read(&output).unwrap(), before);
        // Cancellation before spawn produces no output at all.
        let cancelled: Check = std::sync::Arc::new(|| Err(ReplError::cancelled()));
        let second = dir.join("second.mp4");
        assert!(convert(&input, &second, &tools, &cancelled).is_err());
        assert!(!second.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
