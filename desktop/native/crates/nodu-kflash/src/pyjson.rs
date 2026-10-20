// SPDX-License-Identifier: MIT
// Byte-exact port of the Python `json` behaviours the flash path depends on:
// `json.dumps(value, indent=2, ensure_ascii=True)` for manifest writes,
// `json.dumps(value, separators=(',', ':'))` (optionally `sort_keys=True`)
// for flash-list.json and probe failure metadata, and `json.loads` with the
// duplicate-key `object_pairs_hook` used for restore-package validation.

use serde_json::{Map, Value};

use crate::error::{FlashError, Result};

/// `json.dumps(value, ensure_ascii=True)` string escaping. CPython escapes
/// every code point outside 0x20..=0x7E (plus `"` and `\`) with lowercase
/// `\uXXXX`; non-BMP characters become a surrogate pair.
fn escape_str(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (0x20..=0x7e).contains(&(c as u32)) => out.push(c),
            c => {
                let cp = c as u32;
                if cp > 0xFFFF {
                    let v = cp - 0x10000;
                    out.push_str(&format!(
                        "\\u{:04x}\\u{:04x}",
                        0xD800 + (v >> 10),
                        0xDC00 + (v & 0x3FF)
                    ));
                } else {
                    out.push_str(&format!("\\u{cp:04x}"));
                }
            }
        }
    }
    out.push('"');
}

/// Python `repr(float)`/`str(float)` close enough for JSON output: integral
/// floats keep their `.0` (Rust `{:?}` matches `repr` for every value the
/// flash path emits — all of which are ints anyway).
fn dump_number(n: &serde_json::Number, out: &mut String) {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
    } else if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
    } else {
        let f = n.as_f64().unwrap_or_default();
        if f.is_nan() {
            out.push_str("NaN");
        } else if f.is_infinite() {
            out.push_str(if f > 0.0 { "Infinity" } else { "-Infinity" });
        } else {
            out.push_str(&format!("{f:?}"));
        }
    }
}

fn keys_sorted(map: &Map<String, Value>, sort: bool) -> Vec<&String> {
    let mut keys: Vec<&String> = map.keys().collect();
    if sort {
        keys.sort();
    }
    keys
}

fn dump_compact(value: &Value, sort: bool, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => dump_number(n, out),
        Value::String(s) => escape_str(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                dump_compact(item, sort, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, key) in keys_sorted(map, sort).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                escape_str(key, out);
                out.push(':');
                dump_compact(&map[key], sort, out);
            }
            out.push('}');
        }
    }
}

fn dump_pretty(value: &Value, level: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => dump_number(n, out),
        Value::String(s) => escape_str(s, out),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                out.push_str(&" ".repeat(2 * (level + 1)));
                dump_pretty(item, level + 1, out);
            }
            out.push('\n');
            out.push_str(&" ".repeat(2 * level));
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, key) in map.keys().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                out.push_str(&" ".repeat(2 * (level + 1)));
                escape_str(key, out);
                out.push_str(": ");
                dump_pretty(&map[key], level + 1, out);
            }
            out.push('\n');
            out.push_str(&" ".repeat(2 * level));
            out.push('}');
        }
    }
}

/// `json.dumps(value, indent=2, ensure_ascii=True)` (manifest on-disk form).
pub fn dumps_indent2(value: &Value) -> String {
    let mut out = String::new();
    dump_pretty(value, 0, &mut out);
    out
}

/// `json.dumps(value, separators=(',', ':'), ensure_ascii=True)`.
pub fn dumps_compact(value: &Value) -> String {
    let mut out = String::new();
    dump_compact(value, false, &mut out);
    out
}

/// `json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)`.
pub fn dumps_sorted_compact(value: &Value) -> String {
    let mut out = String::new();
    dump_compact(value, true, &mut out);
    out
}

/// Lenient `json.loads` (last duplicate wins, like Python's default hook).
pub fn loads(text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|_| FlashError::firmware("invalid JSON"))
}

/// Strict `json.loads` used with the restore-package `object_pairs_hook`:
/// any duplicate object key raises the same `FirmwareError` the Python hook
/// produces. Syntax failures surface as a `JSONDecodeError`-named cause so
/// the caller can wrap them exactly like the Python `except ValueError`.
#[derive(Debug)]
pub struct StrictError {
    /// `type(exc).__name__` of the exception Python would have raised.
    pub cause: &'static str,
}

impl std::fmt::Display for StrictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.cause)
    }
}

impl std::error::Error for StrictError {}

pub fn loads_strict(text: &str) -> std::result::Result<Value, StrictError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    let value = parser.value()?;
    parser.ws();
    if parser.pos != parser.bytes.len() {
        return Err(StrictError {
            cause: "JSONDecodeError",
        });
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn fail<T>(&self) -> std::result::Result<T, StrictError> {
        Err(StrictError {
            cause: "JSONDecodeError",
        })
    }

    fn ws(&mut self) {
        while self
            .bytes
            .get(self.pos)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn take(&mut self) -> Option<u8> {
        let b = self.peek();
        if b.is_some() {
            self.pos += 1;
        }
        b
    }

    fn expect(&mut self, literal: &[u8]) -> std::result::Result<(), StrictError> {
        if self.bytes.len() >= self.pos + literal.len()
            && &self.bytes[self.pos..self.pos + literal.len()] == literal
        {
            self.pos += literal.len();
            Ok(())
        } else {
            self.fail()
        }
    }

    fn value(&mut self) -> std::result::Result<Value, StrictError> {
        self.ws();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => {
                self.expect(b"true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.expect(b"false")?;
                Ok(Value::Bool(false))
            }
            Some(b'n') => {
                self.expect(b"null")?;
                Ok(Value::Null)
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.fail(),
        }
    }

    fn object(&mut self) -> std::result::Result<Value, StrictError> {
        self.pos += 1;
        let mut map = Map::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(map));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return self.fail();
            }
            let key = self.string()?;
            self.ws();
            if self.take() != Some(b':') {
                return self.fail();
            }
            let value = self.value()?;
            // object_pairs_hook=_restore_json_object
            if map.contains_key(&key) {
                return Err(StrictError {
                    cause: "FirmwareError",
                });
            }
            map.insert(key, value);
            self.ws();
            match self.take() {
                Some(b',') => {}
                Some(b'}') => return Ok(Value::Object(map)),
                _ => return self.fail(),
            }
        }
    }

    fn array(&mut self) -> std::result::Result<Value, StrictError> {
        self.pos += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value()?);
            self.ws();
            match self.take() {
                Some(b',') => {}
                Some(b']') => return Ok(Value::Array(items)),
                _ => return self.fail(),
            }
        }
    }

    fn string(&mut self) -> std::result::Result<String, StrictError> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let Some(b) = self.take() else {
                return self.fail();
            };
            match b {
                b'"' => return Ok(out),
                b'\\' => {
                    let Some(e) = self.take() else {
                        return self.fail();
                    };
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..=0xDBFF).contains(&hi) {
                                // Surrogate pair like Python's strict scanner.
                                if self.take() != Some(b'\\') || self.take() != Some(b'u') {
                                    return self.fail();
                                }
                                let lo = self.hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&lo) {
                                    return self.fail();
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..=0xDFFF).contains(&hi) {
                                return self.fail();
                            } else {
                                hi
                            };
                            let Some(c) = char::from_u32(cp) else {
                                return self.fail();
                            };
                            out.push(c);
                        }
                        _ => return self.fail(),
                    }
                }
                0x00..=0x1F => return self.fail(),
                _ => {
                    // Collect one UTF-8 scalar (input is already &str).
                    let start = self.pos - 1;
                    let width = utf8_len(b);
                    let end = start + width;
                    if end > self.bytes.len() {
                        return self.fail();
                    }
                    let Ok(c) = std::str::from_utf8(&self.bytes[start..end]) else {
                        return self.fail();
                    };
                    out.push_str(c);
                    self.pos = end;
                }
            }
        }
    }

    fn hex4(&mut self) -> std::result::Result<u32, StrictError> {
        if self.pos + 4 > self.bytes.len() {
            return self.fail();
        }
        let mut v = 0u32;
        for &b in &self.bytes[self.pos..self.pos + 4] {
            let d = match b {
                b'0'..=b'9' => u32::from(b - b'0'),
                b'a'..=b'f' => u32::from(b - b'a' + 10),
                b'A'..=b'F' => u32::from(b - b'A' + 10),
                _ => return self.fail(),
            };
            v = (v << 4) | d;
        }
        self.pos += 4;
        Ok(v)
    }

    fn number(&mut self) -> std::result::Result<Value, StrictError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        // int part: 0 or [1-9][0-9]*
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                    self.pos += 1;
                }
            }
            _ => return self.fail(),
        }
        let mut float = false;
        if self.peek() == Some(b'.') {
            float = true;
            self.pos += 1;
            if !self.peek().is_some_and(|b| b.is_ascii_digit()) {
                return self.fail();
            }
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if self.peek().is_some_and(|b| matches!(b, b'e' | b'E')) {
            float = true;
            self.pos += 1;
            if self.peek().is_some_and(|b| matches!(b, b'+' | b'-')) {
                self.pos += 1;
            }
            if !self.peek().is_some_and(|b| b.is_ascii_digit()) {
                return self.fail();
            }
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap_or("");
        if !float {
            if let Ok(i) = text.parse::<i64>() {
                return Ok(Value::from(i));
            }
            if let Ok(u) = text.parse::<u64>() {
                return Ok(Value::from(u));
            }
            // Python keeps arbitrary precision; f64 is the closest lossy
            // landing zone here and never occurs in restore manifests.
        }
        let f: f64 = text.parse().map_err(|_| StrictError {
            cause: "JSONDecodeError",
        })?;
        serde_json::Number::from_f64(f).map_or_else(|| self.fail(), |n| Ok(Value::Number(n)))
    }
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first < 0xE0 {
        2
    } else if first < 0xF0 {
        3
    } else {
        4
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_matches_python() {
        let v = json!({"version":"0.1.0","files":[{"address":"0x00000000","bin":"full-flash.raw.bin","sha256Prefix":false}]});
        assert_eq!(
            dumps_compact(&v),
            "{\"version\":\"0.1.0\",\"files\":[{\"address\":\"0x00000000\",\"bin\":\"full-flash.raw.bin\",\"sha256Prefix\":false}]}"
        );
    }

    #[test]
    fn indent2_matches_python() {
        let v = json!({"version":1,"ready":true,"nothing":null,"files":[{"a":"b"}],"empty":{},"list":[]});
        let expected = "{\n  \"version\": 1,\n  \"ready\": true,\n  \"nothing\": null,\n  \"files\": [\n    {\n      \"a\": \"b\"\n    }\n  ],\n  \"empty\": {},\n  \"list\": []\n}";
        assert_eq!(dumps_indent2(&v), expected);
    }

    #[test]
    fn ensure_ascii_escapes() {
        assert_eq!(
            dumps_compact(&json!("\u{e9}\u{1}\u{7f}")),
            "\"\\u00e9\\u0001\\u007f\""
        );
        assert_eq!(dumps_compact(&json!("\u{1F600}")), "\"\\ud83d\\ude00\"");
        assert_eq!(dumps_compact(&json!("a\"b\\c")), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn sorted_compact() {
        let v = json!({"b":1,"a":2});
        assert_eq!(dumps_sorted_compact(&v), "{\"a\":2,\"b\":1}");
    }

    #[test]
    fn strict_rejects_duplicates() {
        assert_eq!(
            loads_strict("{\"a\":1,\"a\":2}").unwrap_err().cause,
            "FirmwareError"
        );
        assert!(loads_strict("{\"a\":1}").is_ok());
        assert_eq!(
            loads_strict("{\"a\":}").unwrap_err().cause,
            "JSONDecodeError"
        );
    }

    #[test]
    fn strict_parses_pairs_order() {
        let v = loads_strict("{\"z\":1,\"a\":[true,null,-2.5]}").unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["z", "a"]);
    }
}
