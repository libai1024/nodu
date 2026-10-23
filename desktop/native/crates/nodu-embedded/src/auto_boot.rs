// SPDX-License-Identifier: MIT
//! Explicit, opt-in DTR → BOOT0 / RTS → NRST control. No board detection or implicit pulses.
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::proto::{Failure, Outcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoBoot {
    pub enabled: bool,
    pub confirmed: bool,
    pub boot0_high_dtr: bool,
    pub reset_active_rts: bool,
}
impl AutoBoot {
    pub fn parse(value: &Value, mcu: &str) -> Outcome<Option<Self>> {
        if value.is_null() { return Ok(None); }
        let profile: Self = serde_json::from_value(value.clone()).map_err(|_| Failure::new("badRequest", "自动下载电路配置不完整。"))?;
        if !profile.enabled { return Ok(None); }
        if mcu != "STM32F103C8Tx" || !profile.confirmed {
            return Err(Failure::new("autoBootUnsupported", "自动下载仅适用于已核对接线与极性的 STM32F103C8T6。"));
        }
        Ok(Some(profile))
    }
    pub fn idle_dtr(self) -> bool { !self.boot0_high_dtr }
    pub fn idle_rts(self) -> bool { !self.reset_active_rts }
}

pub trait Signals {
    fn dtr(&mut self, value: bool) -> Outcome<()>;
    fn rts(&mut self, value: bool) -> Outcome<()>;
    fn delay(&mut self, ms: u64);
}
impl Signals for dyn serialport::SerialPort + '_ {
    fn dtr(&mut self, value: bool) -> Outcome<()> { self.write_data_terminal_ready(value).map_err(|e| Failure::new("autoBootSignal", format!("DTR 控制失败：{e}"))) }
    fn rts(&mut self, value: bool) -> Outcome<()> { self.write_request_to_send(value).map_err(|e| Failure::new("autoBootSignal", format!("RTS 控制失败：{e}"))) }
    fn delay(&mut self, ms: u64) { std::thread::sleep(Duration::from_millis(ms)); }
}
impl Signals for Box<dyn serialport::SerialPort> {
    fn dtr(&mut self, value: bool) -> Outcome<()> { self.as_mut().dtr(value) }
    fn rts(&mut self, value: bool) -> Outcome<()> { self.as_mut().rts(value) }
    fn delay(&mut self, ms: u64) { self.as_mut().delay(ms); }
}
pub trait BootPort: crate::uart::ReadWrite + Signals {}
impl<T: crate::uart::ReadWrite + Signals> BootPort for T {}

/// Assert reset first, set the boot pin while reset is held, then release reset.
pub fn pulse<S: Signals + ?Sized>(signals: &mut S, profile: AutoBoot, bootloader: bool) -> Outcome<()> {
    let result = (|| {
        signals.rts(profile.reset_active_rts)?;
        signals.dtr(if bootloader { profile.boot0_high_dtr } else { profile.idle_dtr() })?;
        signals.delay(100);
        signals.rts(profile.idle_rts())?;
        signals.delay(100);
        Ok(())
    })();
    if result.is_err() { let _ = signals.rts(profile.idle_rts()); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)] struct Pins { events: Vec<String>, fail: bool }
    impl Signals for Pins {
        fn dtr(&mut self, value: bool) -> Outcome<()> { self.events.push(format!("dtr:{value}")); if self.fail { Err(Failure::new("io", "test")) } else { Ok(()) } }
        fn rts(&mut self, value: bool) -> Outcome<()> { self.events.push(format!("rts:{value}")); Ok(()) }
        fn delay(&mut self, ms: u64) { self.events.push(format!("wait:{ms}")); }
    }
    #[test] fn enter_exit_and_polarities() {
        for boot0_high_dtr in [false, true] { for reset_active_rts in [false, true] {
            let p = AutoBoot { enabled: true, confirmed: true, boot0_high_dtr, reset_active_rts };
            for boot in [false, true] { let mut pins = Pins::default(); pulse(&mut pins, p, boot).unwrap();
                assert_eq!(pins.events, vec![format!("rts:{}", p.reset_active_rts), format!("dtr:{}", if boot { p.boot0_high_dtr } else { p.idle_dtr() }), "wait:100".into(), format!("rts:{}", p.idle_rts()), "wait:100".into()]);
            }
        }}
    }
    #[test] fn failure_releases_reset_without_another_pulse() {
        let p = AutoBoot { enabled: true, confirmed: true, boot0_high_dtr: false, reset_active_rts: true };
        let mut pins = Pins { fail: true, ..Pins::default() }; assert!(pulse(&mut pins, p, true).is_err());
        assert_eq!(pins.events, ["rts:true", "dtr:false", "rts:false"]);
    }
    #[test] fn configuration_is_opt_in_and_chip_scoped() {
        assert!(AutoBoot::parse(&Value::Null, "STM32F103C8Tx").unwrap().is_none());
        let mut v = serde_json::json!({"enabled": true,"confirmed": false,"boot0HighDtr":false,"resetActiveRts":true});
        assert!(AutoBoot::parse(&v, "STM32F103C8Tx").is_err()); v["confirmed"] = Value::Bool(true);
        assert!(AutoBoot::parse(&v, "STM32F407ZGTx").is_err());
        assert!(AutoBoot::parse(&v, "STM32F103C8Tx").unwrap().is_some());
    }
}
