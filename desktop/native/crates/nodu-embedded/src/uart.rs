// SPDX-License-Identifier: MIT
//! Serial ISP through the STM32 ROM bootloader (FUNCTIONAL-DESIGN §7.3).
//!
//! Nodu itself detects the bootloader (0x7F → ACK), checks the device ID and
//! reads the flash size and UID, so the chip is verified before anything is
//! erased. Backup, write and read-back then go through stm32flash 0.7 with
//! an exact `-S base:length` (a shorter length silently truncates writes).

use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::json;

use crate::process::{self, Control};
use crate::proto::{Failure, Outcome, Output};
use crate::toolkit::Toolkit;

pub const ACK: u8 = 0x79;
pub const NACK: u8 = 0x1F;
const SYNC: u8 = 0x7F;
const GET_ID: u8 = 0x02;
const READ_MEMORY: u8 = 0x11;

fn read_exact(link: &mut dyn ReadWrite, buf: &mut [u8], deadline: Duration) -> io::Result<()> {
    let started = Instant::now();
    let mut filled = 0;
    while filled < buf.len() {
        match link.read(&mut buf[filled..]) {
            Ok(0) => {}
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::TimedOut || e.kind() == io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e),
        }
        if filled < buf.len() && started.elapsed() > deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "no reply from bootloader"));
        }
    }
    Ok(())
}

pub trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn protocol(message: &str) -> Failure {
    Failure::new("romProtocol", format!("串口引导程序没有按预期回应：{message}。按复位键后重试。"))
}

/// One sync attempt. ACK: freshly synced; NACK: already synced earlier.
pub fn sync(link: &mut dyn ReadWrite) -> bool {
    if link.write_all(&[SYNC]).and_then(|()| link.flush()).is_err() {
        return false;
    }
    let mut byte = [0u8; 1];
    read_exact(link, &mut byte, Duration::from_millis(150)).is_ok() && (byte[0] == ACK || byte[0] == NACK)
}

fn expect_ack(link: &mut dyn ReadWrite, what: &str) -> Outcome<()> {
    let mut byte = [0u8; 1];
    read_exact(link, &mut byte, Duration::from_secs(1)).map_err(|_| protocol(&format!("{what} 无应答")))?;
    match byte[0] {
        ACK => Ok(()),
        NACK => Err(Failure::new("romNack", format!("串口引导程序拒绝了 {what}。"))),
        other => Err(protocol(&format!("{what} 返回 0x{other:02x}"))),
    }
}

fn command(link: &mut dyn ReadWrite, cmd: u8, what: &str) -> Outcome<()> {
    link.write_all(&[cmd, !cmd]).map_err(|e| Failure::io("写串口", &e))?;
    expect_ack(link, what)
}

pub fn get_id(link: &mut dyn ReadWrite) -> Outcome<u16> {
    command(link, GET_ID, "GET_ID")?;
    let mut len = [0u8; 1];
    read_exact(link, &mut len, Duration::from_secs(1)).map_err(|_| protocol("GET_ID 长度"))?;
    let mut pid = vec![0u8; usize::from(len[0]) + 1];
    read_exact(link, &mut pid, Duration::from_secs(1)).map_err(|_| protocol("GET_ID 数据"))?;
    expect_ack(link, "GET_ID 结束")?;
    if pid.len() < 2 {
        return Err(protocol("GET_ID 太短"));
    }
    Ok(u16::from_be_bytes([pid[0], pid[1]]))
}

pub fn read_memory(link: &mut dyn ReadWrite, address: u32, len: usize) -> Outcome<Vec<u8>> {
    if len == 0 || len > 256 {
        return Err(Failure::new("badRequest", "一次最多读 256 字节"));
    }
    command(link, READ_MEMORY, "READ_MEMORY").map_err(|f| {
        if f.code == "romNack" {
            Failure::new("readProtected", "芯片开启了读保护，串口引导程序拒绝读取。Nodu 不会解除读保护。")
        } else {
            f
        }
    })?;
    let a = address.to_be_bytes();
    link.write_all(&[a[0], a[1], a[2], a[3], a[0] ^ a[1] ^ a[2] ^ a[3]]).map_err(|e| Failure::io("写串口", &e))?;
    expect_ack(link, "读取地址")?;
    let n = (len - 1) as u8;
    link.write_all(&[n, !n]).map_err(|e| Failure::io("写串口", &e))?;
    expect_ack(link, "读取长度")?;
    let mut data = vec![0u8; len];
    read_exact(link, &mut data, Duration::from_secs(2)).map_err(|_| protocol("读取数据"))?;
    Ok(data)
}

/// Device ID, flash size and UID read over the ROM bootloader.
pub fn identify(link: &mut dyn ReadWrite, flash_size_reg: u64, uid_reg: u64) -> Outcome<serde_json::Value> {
    let pid = get_id(link)?;
    let size = read_memory(link, flash_size_reg as u32, 2)?;
    let uid = read_memory(link, uid_reg as u32, 12)?;
    let words: Vec<u32> = uid.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    Ok(json!({
        "method": "uart",
        "deviceId": pid & 0xfff,
        "deviceIdHex": format!("0x{:03x}", pid & 0xfff),
        "flashKiB": u16::from_le_bytes([size[0], size[1]]),
        "uid": words.iter().map(|w| format!("{w:08x}")).collect::<String>(),
        "uidWords": words.iter().map(|w| format!("0x{w:x}")).collect::<Vec<_>>().join(" "),
        "readProtected": false,
    }))
}

pub fn open_rom(port: &str, baud: u32) -> Outcome<Box<dyn serialport::SerialPort>> {
    serialport::new(port, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::Even)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(Duration::from_millis(100))
        .dtr_on_open(false)
        .open()
        .map_err(|e| Failure::new("portOpen", format!("无法打开串口 {port}：{e}")))
}

/// Poll for the bootloader until it answers, the user stops, or 60 s pass.
pub fn wait_for_rom(port: &str, baud: u32, cancel: &AtomicBool) -> Outcome<Box<dyn serialport::SerialPort>> {
    let started = Instant::now();
    let mut link = open_rom(port, baud)?;
    loop {
        let _ = link.clear(serialport::ClearBuffer::Input);
        if sync(&mut link) {
            return Ok(link);
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(Failure::cancelled());
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err(Failure::new(
                "romTimeout",
                "60 秒内没有检测到芯片的串口引导程序。检查 BOOT0 是否接 1、是否按了复位键，以及 TX、RX 是否交叉连接。",
            ));
        }
        std::thread::sleep(Duration::from_millis(350));
    }
}

/// One stm32flash call; progress percentages become `flash.progress` events.
pub fn stm32flash(toolkit: &Toolkit, args: &[String], out: &Output, run_id: &str, step: &str) -> Outcome<()> {
    let percent = Regex::new(r"\((\d+(?:\.\d+)?)%\)").expect("regex");
    let never = || false;
    let done = process::run(
        &toolkit.stm32flash(),
        args,
        &toolkit.root,
        &toolkit.child_env(),
        Duration::from_secs(300),
        &never,
        &mut |line| {
            if let Some(c) = percent.captures(line) {
                out.event("flash.progress", json!({"runId": run_id, "step": step, "percent": c[1].parse::<f64>().unwrap_or(0.0)}));
            }
            out.event("flash.output", json!({"runId": run_id, "line": line}));
            Control::Continue
        },
    )?;
    if done.ok() {
        Ok(())
    } else {
        let failure = if done.output.contains("Failed to init device") || done.output.contains("Failed to open port") {
            Failure::new("romLost", "stm32flash 连不上串口引导程序。按复位键后重新运行。")
        } else if step == "program" {
            Failure::new("writeFailed", "串口写入失败。芯片里的程序可能不完整，重新下载即可恢复。")
        } else {
            Failure::new("stm32flash", "stm32flash 执行失败。展开详情查看输出。")
        };
        Err(failure.with_detail(json!({"output": process::tail(&done.output, 6000)})))
    }
}

pub fn read_args(baud: u32, file: &Path, base: u64, len: u64, port: &str) -> Vec<String> {
    vec![
        "-b".into(), baud.to_string(), "-m".into(), "8e1".into(),
        "-r".into(), file.display().to_string(),
        "-S".into(), format!("0x{base:08x}:{len}"), port.into(),
    ]
}

pub fn write_args(baud: u32, file: &Path, base: u64, len: u64, port: &str) -> Vec<String> {
    vec![
        "-b".into(), baud.to_string(), "-m".into(), "8e1".into(),
        "-w".into(), file.display().to_string(), "-v".into(),
        "-S".into(), format!("0x{base:08x}:{len}"), port.into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Minimal ROM bootloader: sync, GET_ID and READ_MEMORY over a byte stream.
    struct FakeRom {
        synced: bool,
        protected: bool,
        pid: u16,
        memory: Vec<(u32, Vec<u8>)>,
        pending: Vec<u8>,
        state: u8,
        address: u32,
        reply: VecDeque<u8>,
    }

    impl FakeRom {
        fn new(protected: bool) -> Self {
            Self {
                synced: false, protected, pid: 0x0410,
                memory: vec![(0x1FFF_F7E0, vec![0x40, 0x00]), (0x1FFF_F7E8, vec![0x37, 0xff, 0x71, 0x06, 0x4e, 0x57, 0x34, 0x36, 0x12, 0x55, 0x1e, 0x43])],
                pending: Vec::new(), state: 0, address: 0, reply: VecDeque::new(),
            }
        }
        #[allow(clippy::many_single_char_names)]
        fn byte(&mut self, b: u8) {
            if !self.synced {
                if b == SYNC {
                    self.synced = true;
                    self.reply.push_back(ACK);
                }
                return;
            }
            self.pending.push(b);
            match (self.state, self.pending.as_slice()) {
                (0, [c, n]) => {
                    let (c, n) = (*c, *n);
                    self.pending.clear();
                    if c ^ n != 0xFF {
                        self.reply.push_back(NACK);
                    } else if c == GET_ID {
                        let [hi, lo] = self.pid.to_be_bytes();
                        self.reply.extend([ACK, 1, hi, lo, ACK]);
                    } else if c == READ_MEMORY && !self.protected {
                        self.reply.push_back(ACK);
                        self.state = 1;
                    } else {
                        self.reply.push_back(NACK);
                    }
                }
                (1, [a, b2, c, d, x]) if a ^ b2 ^ c ^ d == *x => {
                    self.address = u32::from_be_bytes([*a, *b2, *c, *d]);
                    self.pending.clear();
                    self.reply.push_back(ACK);
                    self.state = 2;
                }
                (2, [n, inv]) if *n ^ *inv == 0xFF => {
                    let len = usize::from(*n) + 1;
                    self.pending.clear();
                    self.state = 0;
                    self.reply.push_back(ACK);
                    let data = self.memory.iter().find(|(a, _)| *a == self.address).map(|(_, d)| d.clone()).unwrap_or_default();
                    self.reply.extend(data.iter().copied().chain(std::iter::repeat(0xFF)).take(len));
                }
                _ => {}
            }
        }
    }

    impl Read for FakeRom {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.reply.is_empty() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "empty"));
            }
            let n = buf.len().min(self.reply.len());
            for slot in buf.iter_mut().take(n) {
                *slot = self.reply.pop_front().unwrap_or_default();
            }
            Ok(n)
        }
    }

    impl Write for FakeRom {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            for b in buf {
                self.byte(*b);
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn identifies_f103_over_rom_protocol() {
        let mut rom = FakeRom::new(false);
        assert!(sync(&mut rom));
        let id = identify(&mut rom, 0x1FFF_F7E0, 0x1FFF_F7E8).expect("identify");
        assert_eq!(id["deviceId"], 0x410);
        assert_eq!(id["flashKiB"], 64);
        assert_eq!(id["uid"], "0671ff373634574e431e5512");
        assert_eq!(id["uidWords"], "0x671ff37 0x3634574e 0x431e5512");
    }

    #[test]
    fn read_protection_is_reported_not_bypassed() {
        let mut rom = FakeRom::new(true);
        assert!(sync(&mut rom));
        let error = identify(&mut rom, 0x1FFF_F7E0, 0x1FFF_F7E8).expect_err("protected");
        assert_eq!(error.code, "readProtected");
    }

    #[test]
    fn already_synced_rom_answers_nack_and_counts_as_present() {
        let mut rom = FakeRom::new(false);
        assert!(sync(&mut rom));
        // A second 0x7F is taken as the first byte of a command …
        assert!(!sync(&mut rom));
        // … and the next one completes an invalid command: NACK.
        assert!(sync(&mut rom));
    }

    #[test]
    fn stm32flash_arguments_carry_exact_length() {
        let args = write_args(115_200, Path::new("/a/firmware.bin"), 0x0800_0000, 2624, "/dev/cu.usbserial-1");
        assert!(args.windows(2).any(|w| w[0] == "-S" && w[1] == "0x08000000:2624"));
        assert!(args.contains(&"-v".to_string()));
        assert!(!args.iter().any(|a| a == "-e" || a == "-s" || a == "-i" || a == "-g"));
    }
}
