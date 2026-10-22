// SPDX-License-Identifier: MIT
//! Chip definitions, board packs and templates shipped in
//! `scope-extension/resources/stm32` (FUNCTIONAL-DESIGN §3).

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::proto::{Failure, Outcome};
use crate::util::{read_json, sha256_file, str_field};

#[derive(Debug, Clone)]
pub struct Catalog {
    pub root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Chip(pub Value);

impl Chip {
    pub fn id(&self) -> &str {
        str_field(&self.0, &["id"]).unwrap_or_default()
    }
    pub fn name(&self) -> &str {
        str_field(&self.0, &["name"]).unwrap_or_default()
    }
    pub fn family(&self) -> &str {
        str_field(&self.0, &["family"]).unwrap_or_default()
    }
    pub fn series(&self) -> &str {
        str_field(&self.0, &["series"]).unwrap_or_default()
    }
    pub fn u64(&self, path: &[&str]) -> u64 {
        crate::util::u64_field(&self.0, path).unwrap_or_default()
    }
    pub fn flash_base(&self) -> u64 {
        self.u64(&["flash", "base"])
    }
    pub fn flash_size(&self) -> u64 {
        self.u64(&["flash", "size"])
    }
    pub fn ram_base(&self) -> u64 {
        self.u64(&["ram", "base"])
    }
    pub fn ram_size(&self) -> u64 {
        self.u64(&["ram", "size"])
    }
    pub fn device_id(&self) -> u64 {
        self.u64(&["deviceId"])
    }
    pub fn reg(&self, name: &str) -> u64 {
        self.u64(&["registers", name])
    }
    pub fn openocd_target(&self) -> &str {
        str_field(&self.0, &["openocdTarget"]).unwrap_or_default()
    }

    /// Erase units touched by an image of `len` bytes at the flash base.
    pub fn erase_plan(&self, len: u64) -> Value {
        if let Some(sectors) = self.0.pointer("/flash/sectors").and_then(Value::as_array) {
            let mut covered = 0u64;
            let mut count = 0u64;
            for size in sectors.iter().filter_map(Value::as_u64) {
                if covered >= len {
                    break;
                }
                covered += size;
                count += 1;
            }
            let label = if count == 1 { "第 0 扇区".to_string() } else { format!("第 0–{} 扇区", count - 1) };
            json!({"unit": "sector", "count": count, "bytes": covered, "label": label})
        } else {
            let page = self.u64(&["flash", "pageSize"]).max(1);
            let count = len.div_ceil(page).max(1);
            json!({"unit": "page", "count": count, "bytes": count * page,
                   "label": format!("{count} 页（{} KB）", count * page / 1024)})
        }
    }
}

#[derive(Debug, Clone)]
pub struct Board {
    pub value: Value,
    pub dir: PathBuf,
}

impl Board {
    pub fn id(&self) -> &str {
        str_field(&self.value, &["id"]).unwrap_or_default()
    }
    pub fn version(&self) -> u64 {
        crate::util::u64_field(&self.value, &["version"]).unwrap_or(1)
    }
    pub fn reference(&self) -> String {
        format!("{}@{}", self.id(), self.version())
    }
    pub fn name(&self) -> &str {
        str_field(&self.value, &["name"]).unwrap_or_default()
    }
    pub fn mcu(&self) -> &str {
        str_field(&self.value, &["mcu"]).unwrap_or_default()
    }
    pub fn verified_led(&self) -> Option<&Value> {
        self.value
            .get("leds")?
            .as_array()?
            .iter()
            .find(|led| led.get("pin").is_some_and(Value::is_string) && led.get("verified").is_some_and(Value::is_string))
    }
    pub fn has_debug_uart(&self) -> bool {
        self.value.pointer("/debugUart/instance").is_some_and(Value::is_string)
    }
    pub fn stlink_speed(&self) -> u64 {
        crate::util::u64_field(&self.value, &["flash", "stlink", "speedKhz"]).unwrap_or(1000)
    }
    pub fn digest(&self) -> String {
        sha256_file(&self.dir.join("board.json")).unwrap_or_default()
    }
}

impl Catalog {
    pub fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf() }
    }

    fn safe_id(id: &str) -> Outcome<&str> {
        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(Failure::new("badRequest", format!("无效的标识：{id}")));
        }
        Ok(id)
    }

    pub fn chip(&self, id: &str) -> Outcome<Chip> {
        let id = Self::safe_id(id)?;
        let path = self.root.join("chips").join(format!("{id}.json"));
        if !path.is_file() {
            return Err(Failure::new("unknownChip", format!("Nodu 不支持芯片 {id}。")));
        }
        Ok(Chip(read_json(&path)?))
    }

    /// `id@version`; a missing version means the newest one shipped.
    pub fn board(&self, reference: &str) -> Outcome<Board> {
        let (id, version) = reference.split_once('@').map_or((reference, None), |(i, v)| (i, Some(v)));
        let id = Self::safe_id(id)?;
        let base = self.root.join("boards").join(id);
        let version = match version {
            Some(v) if v.chars().all(|c| c.is_ascii_digit()) && !v.is_empty() => v.to_string(),
            Some(_) => return Err(Failure::new("badRequest", format!("无效的板卡包版本：{reference}"))),
            None => std::fs::read_dir(&base)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
                .max()
                .map(|v| v.to_string())
                .ok_or_else(|| Failure::new("unknownBoard", format!("找不到板卡包 {id}。")))?,
        };
        let dir = base.join(&version);
        if !dir.join("board.json").is_file() {
            return Err(Failure::new("unknownBoard", format!("找不到板卡包 {reference}。")));
        }
        Ok(Board { value: read_json(&dir.join("board.json"))?, dir })
    }

    pub fn templates(&self) -> Outcome<Vec<Value>> {
        let index = read_json(&self.root.join("templates/templates.json"))?;
        Ok(index.get("templates").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    pub fn hal_modules(&self) -> Vec<String> {
        read_json(&self.root.join("templates/templates.json"))
            .ok()
            .and_then(|v| v.get("halModules").cloned())
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// Everything the new-project wizard shows: boards with their chip and
    /// which templates their verified facts allow.
    pub fn listing(&self) -> Outcome<Value> {
        let templates = self.templates()?;
        let mut boards = Vec::new();
        let mut ids: Vec<String> = std::fs::read_dir(self.root.join("boards"))
            .map_err(|e| Failure::io("读取板卡包", &e))?
            .filter_map(|e| e.ok()?.file_name().to_str().map(str::to_string))
            .filter(|n| !n.starts_with('.'))
            .collect();
        ids.sort();
        for id in ids {
            let board = self.board(&id)?;
            let chip = self.chip(board.mcu())?;
            let offered: Vec<&str> = board
                .value
                .get("templates")
                .and_then(Value::as_array)
                .map(|t| t.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let options: Vec<Value> = templates
                .iter()
                .filter(|t| offered.contains(&str_field(t, &["id"]).unwrap_or_default()))
                .map(|t| {
                    let needs: Vec<&str> = t.get("needs").and_then(Value::as_array)
                        .map(|n| n.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                    let mut available = true;
                    let mut needs_input = Vec::new();
                    let mut reason = Value::Null;
                    if needs.contains(&"debugUart") && !board.has_debug_uart() {
                        available = false;
                        reason = json!("板卡包没有调试串口");
                    }
                    if needs.contains(&"led") && board.verified_led().is_none() {
                        needs_input.push("led");
                        reason = json!(board.value.get("ledHint").cloned().unwrap_or(json!("需要填写 LED 引脚")));
                    }
                    json!({"id": t["id"], "name": t["name"], "description": t["description"],
                           "available": available, "needsInput": needs_input, "reason": reason})
                })
                .collect();
            boards.push(json!({
                "id": board.id(), "version": board.version(), "reference": board.reference(),
                "name": board.name(), "description": board.value.get("description"),
                "mcu": chip.id(), "chipName": chip.name(), "core": chip.0.get("core"),
                "flashKiB": chip.flash_size() / 1024, "ramKiB": chip.ram_size() / 1024,
                "gpioPorts": chip.0.get("gpioPorts"),
                "debugUart": board.value.get("debugUart"), "led": board.verified_led(),
                "boot": board.value.get("boot"), "flash": board.value.get("flash"),
                "templates": options,
            }));
        }
        Ok(json!({"boards": boards}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        Catalog::new(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scope-extension/resources/stm32"))
    }

    #[test]
    fn shipped_packs_load_and_list() {
        let listing = catalog().listing().expect("listing");
        let boards = listing["boards"].as_array().expect("boards");
        assert!(boards.iter().any(|b| b["mcu"] == "STM32F103C8Tx"));
        assert!(boards.iter().any(|b| b["mcu"] == "STM32F407ZGTx"));
        // No board pack ships an unverified LED, so blink always asks for the pin.
        for board in boards {
            let blink = board["templates"].as_array().unwrap().iter().find(|t| t["id"] == "blink").unwrap();
            assert_eq!(blink["needsInput"], json!(["led"]));
        }
    }

    #[test]
    fn erase_plans() {
        let f4 = catalog().chip("STM32F407ZGTx").unwrap();
        assert_eq!(f4.erase_plan(3592)["label"], "第 0 扇区");
        assert_eq!(f4.erase_plan(70_000)["count"], 5);
        let f1 = catalog().chip("STM32F103C8Tx").unwrap();
        assert_eq!(f1.erase_plan(2624)["count"], 3);
    }

    #[test]
    fn rejects_path_like_ids() {
        assert!(catalog().board("../chips").is_err());
        assert!(catalog().chip("../../x").is_err());
    }
}
