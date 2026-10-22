// SPDX-License-Identifier: MIT
//! ST-LINK detection from the OS USB device list, without opening the probe
//! (OpenOCD owns it while a download runs). Windows also reports whether a
//! driver is bound, so a missing ST driver can be explained (T9).

use regex::Regex;
use serde_json::{Value, json};

const ST_VID: u64 = 0x0483;
/// Product IDs listed in OpenOCD 0.12 `interface/stlink.cfg`.
const STLINK_PIDS: [u64; 9] = [0x3744, 0x3748, 0x374b, 0x374d, 0x374e, 0x374f, 0x3752, 0x3753, 0x3754];

fn model(pid: u64) -> &'static str {
    match pid {
        0x3744 => "ST-LINK/V1",
        0x3748 => "ST-LINK/V2",
        0x374b | 0x3752 => "ST-LINK/V2-1",
        0x374d | 0x374e | 0x374f | 0x3753 | 0x3754 => "STLINK-V3",
        _ => "ST-LINK",
    }
}

fn probe(pid: u64, serial: &str, product: &str, driver: Value) -> Value {
    json!({"vid": ST_VID, "pid": pid, "model": model(pid), "serial": serial, "product": product, "driver": driver})
}

/// `ioreg -p IOUSB -l -w0` text: a `+-o` line starts each device.
pub fn parse_ioreg(text: &str) -> Vec<Value> {
    let start = Regex::new(r"\+-o ").expect("regex");
    let field = Regex::new(r#""(idVendor|idProduct|USB Serial Number|USB Product Name)" = (?:"([^"]*)"|(\d+))"#).expect("regex");
    let mut out = Vec::new();
    let mut current: Vec<(String, String)> = Vec::new();
    let flush = |fields: &[(String, String)], out: &mut Vec<Value>| {
        let get = |k: &str| fields.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        let vid = get("idVendor").and_then(|v| v.parse::<u64>().ok());
        let pid = get("idProduct").and_then(|v| v.parse::<u64>().ok());
        if let (Some(ST_VID), Some(pid)) = (vid, pid) {
            if STLINK_PIDS.contains(&pid) {
                out.push(probe(pid, get("USB Serial Number").unwrap_or(""), get("USB Product Name").unwrap_or("ST-LINK"), json!("ok")));
            }
        }
    };
    for line in text.lines() {
        if start.is_match(line) {
            flush(&current, &mut out);
            current.clear();
        }
        if let Some(c) = field.captures(line) {
            let value = c.get(2).or(c.get(3)).map(|m| m.as_str().to_string()).unwrap_or_default();
            current.push((c[1].to_string(), value));
        }
    }
    flush(&current, &mut out);
    out
}

/// `InstanceId|Status|FriendlyName` lines from PowerShell `Get-PnpDevice`.
pub fn parse_pnp(text: &str) -> Vec<Value> {
    let id = Regex::new(r"(?i)USB\\VID_0483&PID_([0-9A-F]{4})\\([^|]*)").expect("regex");
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.trim().split('|').collect();
            let c = id.captures(parts.first()?)?;
            let pid = u64::from_str_radix(&c[1], 16).ok()?;
            if !STLINK_PIDS.contains(&pid) {
                return None;
            }
            let status = parts.get(1).copied().unwrap_or("");
            let driver = if status.eq_ignore_ascii_case("OK") { json!("ok") } else { json!("missing") };
            Some(probe(pid, &c[2], parts.get(2).copied().unwrap_or("ST-LINK"), driver))
        })
        .collect()
}

pub fn list() -> Vec<Value> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/sbin/ioreg")
            .args(["-p", "IOUSB", "-l", "-w0"])
            .output()
            .map(|o| parse_ioreg(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_0483*' } | ForEach-Object { $_.InstanceId + '|' + $_.Status + '|' + $_.FriendlyName }";
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| parse_pnp(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut out = Vec::new();
        for entry in std::fs::read_dir("/sys/bus/usb/devices").into_iter().flatten().flatten() {
            let read = |name: &str| std::fs::read_to_string(entry.path().join(name)).unwrap_or_default().trim().to_string();
            let (Ok(vid), Ok(pid)) = (u64::from_str_radix(&read("idVendor"), 16), u64::from_str_radix(&read("idProduct"), 16)) else { continue };
            if vid == ST_VID && STLINK_PIDS.contains(&pid) {
                out.push(probe(pid, &read("serial"), &read("product"), json!("ok")));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ioreg_finds_stlink_with_empty_serial() {
        let text = r#"
  | | +-o USB2.1 Hub@03120000  <class IOUSBHostDevice>
  | |   |   "idProduct" = 20654
  | |   |   "idVendor" = 10007
  | |   +-o STM32 STLink@03121000  <class IOUSBHostDevice>
  | |         "idProduct" = 14152
  | |         "USB Product Name" = "STM32 STLink"
  | |         "kUSBSerialNumberString" =
  | |         "idVendor" = 1155
  | |         "USB Serial Number" =
  | +-o USB3 Gen2 Hub@03200000  <class IOUSBHostDevice>
  |       "idVendor" = 1452
"#;
        let probes = parse_ioreg(text);
        assert_eq!(probes.len(), 1);
        assert_eq!(probes[0]["model"], "ST-LINK/V2");
        assert_eq!(probes[0]["serial"], "");
    }

    #[test]
    fn pnp_reports_missing_driver() {
        let text = "USB\\VID_0483&PID_3748\\066DFF485550755187121|Error|STM32 STLink\nUSB\\VID_1234&PID_0001\\X|OK|Other\n";
        let probes = parse_pnp(text);
        assert_eq!(probes.len(), 1);
        assert_eq!(probes[0]["driver"], "missing");
        assert_eq!(probes[0]["serial"], "066DFF485550755187121");
    }
}
