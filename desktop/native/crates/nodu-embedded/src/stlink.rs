// SPDX-License-Identifier: MIT
//! ST-LINK through OpenOCD (FUNCTIONAL-DESIGN §7.2).
//!
//! Each step is one OpenOCD process driven by `-c` commands. Values come back
//! as `NODU:key=value` lines from `echo`; a Tcl `error` aborts the remaining
//! commands, which is how the chip guards stop a write on the wrong board.
//! `reset_config none`: reset goes through SYSRESETREQ, so boards without
//! NRST wired to the probe work too.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use crate::catalog::{Board, Chip};
use crate::process::{self, Control};
use crate::proto::{Failure, Outcome, Output};
use crate::toolkit::Toolkit;

#[derive(Debug)]
pub struct Session<'a> {
    pub toolkit: &'a Toolkit,
    pub chip: &'a Chip,
    pub board: &'a Board,
    /// USB serial of the probe to use; empty selects the only one present.
    pub serial: &'a str,
    pub out: &'a Output,
    pub cancel: &'a AtomicBool,
    pub run_id: &'a str,
}

/// Tcl brace-quoted path. Braces and newlines cannot be expressed safely.
pub fn tcl_path(path: &Path) -> Outcome<String> {
    let text = path.display().to_string().replace('\\', "/");
    if text.contains(['{', '}', '\n', '\r']) {
        return Err(Failure::new("badPath", format!("路径中不能有花括号或换行：{text}")));
    }
    Ok(format!("{{{text}}}"))
}

fn hex32(value: u64) -> String {
    format!("0x{value:08x}")
}

/// Values OpenOCD prints for `read_memory`, e.g. `0x6410` or `0x671ff37 0x3634574e 0x431e5512`.
fn parse_words(text: &str) -> Vec<u64> {
    text.split_whitespace()
        .filter_map(|w| u64::from_str_radix(w.trim_start_matches("0x"), 16).ok())
        .collect()
}

#[derive(Debug, Default)]
pub struct Markers {
    pub values: BTreeMap<String, String>,
    pub voltage: Option<f64>,
    pub probe: Option<String>,
}

impl Session<'_> {
    fn args(&self, commands: &[String]) -> Vec<String> {
        let mut args = vec![
            "-s".into(),
            self.toolkit.openocd_scripts().display().to_string(),
            "-f".into(),
            "interface/stlink.cfg".into(),
        ];
        if !self.serial.is_empty() {
            args.extend(["-c".into(), format!("adapter serial {}", self.serial)]);
        }
        // Accept any debug-port ID: the F4 config would refuse an F103 before
        // Nodu can read its device ID and say which chip is on the board.
        args.extend(["-c".into(), "set CPUTAPID 0".into()]);
        args.extend(["-f".into(), self.chip.openocd_target().to_string()]);
        for command in [
            "reset_config none".to_string(),
            format!("adapter speed {}", self.board.stlink_speed()),
            "gdb_port disabled".into(),
            "telnet_port disabled".into(),
            "tcl_port disabled".into(),
            "init".into(),
        ]
        .into_iter()
        .chain(commands.iter().cloned())
        .chain(std::iter::once("shutdown".to_string()))
        {
            args.extend(["-c".into(), command]);
        }
        args
    }

    /// Run one OpenOCD session; `step` lines become `flash.step` events.
    fn run(&self, commands: &[String], timeout: Duration, cancellable: bool) -> Outcome<(process::Finished, Markers)> {
        let marker = Regex::new(r"^NODU:([a-z0-9]+)=(.*)$").expect("regex");
        let voltage = Regex::new(r"Target voltage: ([\d.]+)").expect("regex");
        let probe = Regex::new(r"Info : (STLINK \S+).*VID:PID").expect("regex");
        let mut markers = Markers::default();
        let finished = process::run(
            &self.toolkit.openocd(),
            &self.args(commands),
            &self.toolkit.root,
            &self.toolkit.child_env(),
            timeout,
            &|| cancellable && self.cancel.load(Ordering::Relaxed),
            &mut |line| {
                if let Some(c) = marker.captures(line) {
                    if &c[1] == "step" {
                        let step = match c[2].trim() {
                            "halt" | "program" => Some("program"),
                            "verify" => Some("verify"),
                            "backup" => Some("backup"),
                            _ => None,
                        };
                        if let Some(step) = step {
                            self.out.event("flash.step", json!({"runId": self.run_id, "step": step, "state": "running"}));
                        }
                    }
                    markers.values.insert(c[1].to_string(), c[2].trim().to_string());
                } else if let Some(c) = voltage.captures(line) {
                    markers.voltage = c[1].parse().ok();
                } else if let Some(c) = probe.captures(line) {
                    markers.probe = Some(c[1].to_string());
                }
                self.out.event("flash.output", json!({"runId": self.run_id, "line": line}));
                Control::Continue
            },
        )?;
        Ok((finished, markers))
    }

    fn guards(&self, uid: &str) -> Vec<String> {
        vec![
            format!(
                "if {{([read_memory {} 32 1] & 0xfff) != {}}} {{error NODU_WRONG_CHIP}}",
                hex32(self.chip.reg("idcode")),
                hex32(self.chip.device_id())
            ),
            format!("if {{[read_memory {} 32 3] ne {{{uid}}}}} {{error NODU_CHIP_CHANGED}}", hex32(self.chip.reg("uid"))),
        ]
    }

    /// Read device ID, flash size, UID and read protection without halting.
    pub fn identify(&self) -> Outcome<Value> {
        let rdp = self.chip.0.pointer("/registers/rdp").cloned().unwrap_or(Value::Null);
        let rdp_address = rdp.get("address").and_then(Value::as_u64).unwrap_or(0);
        // The flash-size, UID and option registers live at family-specific
        // addresses; reading them on another family faults, so they are read
        // only after the device ID matches the project's chip.
        let commands = vec![
            format!("set nodu_id [read_memory {} 32 1]", hex32(self.chip.reg("idcode"))),
            "echo \"NODU:idcode=$nodu_id\"".to_string(),
            format!(
                "if {{($nodu_id & 0xfff) == {}}} {{echo \"NODU:flashkib=[read_memory {} 16 1]\"; echo \"NODU:uid=[read_memory {} 32 3]\"; echo \"NODU:rdp=[read_memory {} 32 1]\"}}",
                hex32(self.chip.device_id()),
                hex32(self.chip.reg("flashSize")),
                hex32(self.chip.reg("uid")),
                hex32(rdp_address)
            ),
            "echo NODU:done=identify".to_string(),
        ];
        let (finished, markers) = self.run(&commands, Duration::from_secs(20), true)?;
        let get = |k: &str| markers.values.get(k).map(String::as_str).unwrap_or_default();
        if !finished.ok() || !markers.values.contains_key("done") || get("idcode").is_empty() {
            return Err(classify(&finished.output, markers.voltage));
        }
        let idcode = parse_words(get("idcode")).first().copied().unwrap_or(0);
        if get("uid").is_empty() {
            // Another chip family: report what is on the board, nothing more.
            return Ok(json!({
                "method": "stlink", "deviceId": idcode & 0xfff, "deviceIdHex": format!("0x{:03x}", idcode & 0xfff),
                "revisionId": format!("0x{:04x}", idcode >> 16), "flashKiB": Value::Null, "uid": Value::Null,
                "uidWords": Value::Null, "readProtected": Value::Null, "voltage": markers.voltage, "probe": markers.probe,
            }));
        }
        let flash_kib = parse_words(get("flashkib")).first().copied().unwrap_or(0);
        let rdp_value = parse_words(get("rdp")).first().copied().unwrap_or(0);
        let mask = rdp.get("mask").and_then(Value::as_u64).unwrap_or(0);
        let level0 = rdp.get("level0").and_then(Value::as_u64).unwrap_or(0);
        let protected = rdp_value & mask != level0;
        let uid_words = parse_words(get("uid"));
        let uid_hex: String = uid_words.iter().map(|w| format!("{w:08x}")).collect();
        Ok(json!({
            "method": "stlink",
            "deviceId": idcode & 0xfff,
            "deviceIdHex": format!("0x{:03x}", idcode & 0xfff),
            "revisionId": format!("0x{:04x}", idcode >> 16),
            "flashKiB": flash_kib,
            "uid": uid_hex,
            "uidWords": get("uid"),
            "readProtected": protected,
            "voltage": markers.voltage,
            "probe": markers.probe,
        }))
    }

    /// Whole-flash backup while the current program keeps its state (halt / resume).
    pub fn backup(&self, uid_words: &str, file: &Path, bytes: u64) -> Outcome<()> {
        let mut commands = self.guards(uid_words);
        commands.extend([
            "echo NODU:step=backup".into(),
            "halt".into(),
            format!("dump_image {} {} {bytes}", tcl_path(file)?, hex32(self.chip.flash_base())),
            "resume".into(),
            "echo NODU:done=backup".into(),
        ]);
        let (finished, markers) = self.run(&commands, Duration::from_secs(300), true)?;
        if !finished.ok() || !markers.values.contains_key("done") {
            return Err(classify(&finished.output, markers.voltage));
        }
        Ok(())
    }

    /// Erase the touched units, write, verify, read back and start the program.
    /// Not cancellable: stopping OpenOCD mid-erase leaves the chip half written.
    pub fn program(&self, uid_words: &str, image: &Path, readback: &Path, len: u64, tick: Option<u64>) -> Outcome<Value> {
        let base = hex32(self.chip.flash_base());
        let mut commands = self.guards(uid_words);
        commands.extend([
            "echo NODU:step=halt".into(),
            "reset halt".into(),
            "echo NODU:step=program".into(),
            format!("flash write_image erase {} {base} bin", tcl_path(image)?),
            "echo NODU:step=verify".into(),
            format!("verify_image {} {base} bin", tcl_path(image)?),
            format!("dump_image {} {base} {len}", tcl_path(readback)?),
            "echo NODU:step=run".into(),
            "reset run".into(),
            "echo NODU:written=1".into(),
        ]);
        if let Some(tick) = tick {
            commands.extend([
                "sleep 300".into(),
                format!("echo \"NODU:tick1=[read_memory {} 32 1]\"", hex32(tick)),
                "sleep 300".into(),
                format!("echo \"NODU:tick2=[read_memory {} 32 1]\"", hex32(tick)),
            ]);
        }
        let (finished, markers) = self.run(&commands, Duration::from_secs(300), false)?;
        if !markers.values.contains_key("written") {
            let mut failure = classify(&finished.output, markers.voltage);
            if finished.output.contains("NODU_WRONG_CHIP") || finished.output.contains("NODU_CHIP_CHANGED") {
                return Err(failure);
            }
            if markers.values.get("step").is_some_and(|s| s != "halt") {
                failure.message = format!("{} 芯片里的程序可能不完整，重新下载即可恢复。", failure.message);
                failure.code = "writeFailed";
            }
            return Err(failure);
        }
        let ticks: Vec<u64> = ["tick1", "tick2"]
            .iter()
            .filter_map(|k| markers.values.get(*k).and_then(|v| parse_words(v).first().copied()))
            .collect();
        let running = (ticks.len() == 2).then(|| ticks[1] > ticks[0]);
        Ok(json!({"running": running, "ticks": ticks}))
    }

    pub fn reset(&self) -> Outcome<()> {
        let (finished, markers) = self.run(&["reset run".into(), "echo NODU:done=reset".into()], Duration::from_secs(20), true)?;
        if !finished.ok() || !markers.values.contains_key("done") {
            return Err(classify(&finished.output, markers.voltage));
        }
        Ok(())
    }
}

/// Map OpenOCD output to the first failed check (diagnosis card, F9).
pub fn classify(output: &str, voltage: Option<f64>) -> Failure {
    let detail = json!({"output": process::tail(output, 6000), "voltage": voltage});
    let failure = if output.contains("NODU_WRONG_CHIP") || output.contains("UNEXPECTED idcode") {
        Failure::new("wrongChip", "板上的芯片与工程的目标芯片不同，没有写入。")
    } else if output.contains("NODU_CHIP_CHANGED") {
        Failure::new("chipChanged", "识别之后换了板子，没有写入。重新运行即可。")
    } else if output.contains("LIBUSB_ERROR_BUSY") || output.contains("LIBUSB_ERROR_ACCESS") {
        Failure::new("probeBusy", "ST-LINK 正被其他程序（例如 STM32CubeProgrammer）使用。关闭它后重试。")
    } else if output.contains("open failed") || output.contains("No device found") || output.contains("unable to open") {
        Failure::new("noProbe", "没有检测到 ST-LINK。检查 USB 线是否插好，或换一个 USB 口。")
    } else if voltage.is_some_and(|v| v < 1.5) {
        Failure::new("noPower", "开发板没有供电（目标电压接近 0 V）。检查开发板电源，或 ST-LINK 的 3.3V 是否接到板上。")
    } else if output.contains("init mode failed") || output.contains("unable to connect to the target") || output.contains("Error connecting DP") {
        Failure::new("noTarget", "ST-LINK 连不上芯片。检查 SWDIO、SWCLK、GND 三根线；芯片在低功耗模式时，按住复位键再点运行。")
    } else if output.contains("timed out while waiting for target halted") || output.contains("reset device failed") {
        Failure::new("haltFailed", "芯片没有响应停止命令。按一下开发板的复位键后重试。")
    } else if output.contains("flash write failed") || output.contains("failed erasing sectors") || output.contains("error writing to flash") {
        Failure::new("writeFailed", "写入 Flash 失败。")
    } else if output.contains("verify failed") || output.contains("checksum mismatch") {
        Failure::new("verifyFailed", "写入后校验不一致。")
    } else {
        Failure::new("openocd", "下载器操作失败。展开详情查看 OpenOCD 输出。")
    };
    failure.with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_paths() {
        assert_eq!(parse_words("0x671ff37 0x3634574e 0x431e5512"), vec![0x0671_ff37, 0x3634_574e, 0x431e_5512]);
        assert_eq!(tcl_path(Path::new("/a b/中文/x.bin")).unwrap(), "{/a b/中文/x.bin}");
        assert!(tcl_path(Path::new("/a{b}")).is_err());
    }

    #[test]
    fn classification_order() {
        assert_eq!(classify("Error: open failed", None).code, "noProbe");
        assert_eq!(classify("Info : Target voltage: 0.012\nError: init mode failed (unable to connect to the target)", Some(0.012)).code, "noPower");
        assert_eq!(classify("Error: init mode failed (unable to connect to the target)", Some(3.2)).code, "noTarget");
        assert_eq!(classify("NODU_WRONG_CHIP\n", Some(3.3)).code, "wrongChip");
    }
}
