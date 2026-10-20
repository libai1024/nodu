// SPDX-License-Identifier: MIT
// Raw (headerless) DEFLATE via the system zlib — the same library and
// defaults CPython's zlib module uses on macOS (libz 1.2.12), so compressed
// member streams are byte-identical to Python zipfile output.

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// Errors here map to Python's `zlib.error` in the restore-package wrapper.
#[derive(Debug)]
pub struct ZlibError;

impl std::fmt::Display for ZlibError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("zlib error")
    }
}

impl std::error::Error for ZlibError {}

/// `zlib.compressobj(-1, DEFLATED, -15).compress(data) + flush()` in one shot:
/// level 6, default memLevel/strategy, raw stream.
pub fn deflate(data: &[u8]) -> Vec<u8> {
    let mut c = Compress::new(Compression::new(6), false);
    // Worst case fits comfortably inside input + slack; grow on demand.
    let mut out = Vec::with_capacity(data.len() / 4 + 256);
    let mut fed = 0usize;
    loop {
        let before_in = c.total_in();
        let before_out = c.total_out();
        if out.capacity() == out.len() {
            out.reserve(out.len().max(1024) * 2);
        }
        let spare = out.capacity() - out.len();
        // SAFETY-free approach: use Vec::spare_capacity_mut via a scratch buf.
        let mut scratch = vec![0u8; spare];
        let status = c
            .compress(&data[fed..], &mut scratch, FlushCompress::None)
            .unwrap_or(Status::Ok);
        let produced = (c.total_out() - before_out) as usize;
        out.extend_from_slice(&scratch[..produced]);
        fed += (c.total_in() - before_in) as usize;
        if fed == data.len() {
            break;
        }
        if matches!(status, Status::BufError) && produced == 0 {
            // Defensive: should be unreachable because we always grow.
            break;
        }
    }
    loop {
        let before_out = c.total_out();
        let mut scratch = vec![0u8; 64 * 1024];
        let status = c
            .compress(&[], &mut scratch, FlushCompress::Finish)
            .unwrap_or(Status::StreamEnd);
        let produced = (c.total_out() - before_out) as usize;
        out.extend_from_slice(&scratch[..produced]);
        if status == Status::StreamEnd {
            break;
        }
    }
    out
}

/// Streaming inflater equivalent to `zipfile`'s member reader: feed packed
/// bytes, take inflated output; `finished` reports end-of-stream so callers
/// can enforce the expected uncompressed length exactly like
/// `stream.read(n)` returning `b''` at EOF.
#[derive(Debug)]
pub struct Inflater {
    inner: Decompress,
    done: bool,
}

impl Inflater {
    pub fn new() -> Self {
        Self {
            inner: Decompress::new(false),
            done: false,
        }
    }

    /// Inflate `chunk`, appending produced bytes to `out`. Mirrors zlib's
    /// `decompress` error on corrupt streams.
    pub fn feed(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> std::result::Result<(), ZlibError> {
        if self.done {
            if !chunk.is_empty() {
                // Bytes past stream end — zipfile would leave them to the
                // next member/EOCD scan; our reader slices members exactly,
                // so trailing bytes mean a malformed container.
                return Err(ZlibError);
            }
            return Ok(());
        }
        let mut pos = 0usize;
        loop {
            let before_in = self.inner.total_in();
            let before_out = self.inner.total_out();
            if out.capacity() == out.len() {
                out.reserve((out.len().max(4096)) * 2);
            }
            let mut scratch = vec![0u8; out.capacity() - out.len()];
            let status = self
                .inner
                .decompress(&chunk[pos..], &mut scratch, FlushDecompress::None)
                .map_err(|_| ZlibError)?;
            let consumed = (self.inner.total_in() - before_in) as usize;
            let produced = (self.inner.total_out() - before_out) as usize;
            out.extend_from_slice(&scratch[..produced]);
            pos += consumed;
            match status {
                Status::StreamEnd => {
                    self.done = true;
                    if pos != chunk.len() {
                        return Err(ZlibError);
                    }
                    return Ok(());
                }
                Status::Ok | Status::BufError => {
                    if consumed == 0 && produced == 0 {
                        if pos < chunk.len() {
                            // Needs more output space — scratch was exhausted
                            // mid-block; loop grows and continues.
                            continue;
                        }
                        return Ok(());
                    }
                    if pos == chunk.len() {
                        return Ok(());
                    }
                }
            }
        }
    }

    /// True once the DEFLATE stream end marker was consumed.
    pub fn finished(&self) -> bool {
        self.done
    }

    /// Inflate `packed` fully in one call (small members).
    pub fn inflate_all(packed: &[u8]) -> std::result::Result<Vec<u8>, ZlibError> {
        let mut inf = Self::new();
        let mut out = Vec::new();
        inf.feed(packed, &mut out)?;
        if !inf.done {
            return Err(ZlibError);
        }
        Ok(out)
    }
}

impl Default for Inflater {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let data = b"hello hello hello deflate";
        let packed = deflate(data);
        let out = Inflater::inflate_all(&packed).expect("inflate");
        assert_eq!(out, data);
    }

    #[test]
    fn known_stream_matches_python_zlib() {
        // python3 -c 'zlib.compressobj(-1, zlib.DEFLATED, -15).compress(b"abc"*8)+flush()'
        let expected: [u8; 7] = [0x4b, 0x4c, 0x4a, 0x4e, 0xc4, 0x86, 0x00];
        assert_eq!(deflate(&b"abc".repeat(8)), expected);
    }
}
