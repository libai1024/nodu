// SPDX-License-Identifier: MIT
//! JSON-lines framing shared with `nodu-device`: requests `{id, method, args}`,
//! replies `{id, result}` or `{id, error, code, detail}`, events `{event, data}`.

use std::fmt;
use std::io::Write;
use std::sync::Mutex;

use serde_json::{Value, json};

/// A user-facing failure: `code` is stable for the frontend, `message` is Chinese text.
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub detail: Option<Value>,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), detail: None }
    }
    #[must_use]
    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }
    pub fn io(context: &str, error: &std::io::Error) -> Self {
        Self::new("io", format!("{context}：{error}"))
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", "已停止。")
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Outcome<T> = Result<T, Failure>;

/// Serialized writer for stdout; every line is one complete JSON value.
pub struct Output {
    sink: Mutex<Box<dyn Write + Send>>,
}

impl fmt::Debug for Output {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Output")
    }
}

impl Output {
    pub fn new(sink: Box<dyn Write + Send>) -> Self {
        Self { sink: Mutex::new(sink) }
    }
    fn write(&self, value: &Value) {
        let mut line = value.to_string();
        line.push('\n');
        if let Ok(mut sink) = self.sink.lock() {
            let _ = sink.write_all(line.as_bytes());
            let _ = sink.flush();
        }
    }
    pub fn reply(&self, id: &Value, outcome: Outcome<Value>) {
        match outcome {
            Ok(result) => self.write(&json!({"id": id, "result": result})),
            Err(failure) => {
                let mut value = json!({"id": id, "error": failure.message, "code": failure.code});
                if let Some(detail) = failure.detail {
                    value["detail"] = detail;
                }
                self.write(&value);
            }
        }
    }
    pub fn event(&self, name: &str, data: Value) {
        self.write(&json!({"event": name, "data": data}));
    }
}

/// Typed argument helpers: missing or wrong-typed fields are request errors.
pub fn arg_str<'a>(args: &'a Value, key: &str) -> Outcome<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| Failure::new("badRequest", format!("缺少参数 {key}")))
}

pub fn arg_opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.is_empty() && !s.contains('\0'))
}

pub fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}
