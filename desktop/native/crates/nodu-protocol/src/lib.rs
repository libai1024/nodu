// SPDX-License-Identifier: MIT
//! Wire types for the nodu-device stdio JSON-lines protocol.
//!
//! The TypeScript declarations under
//! `desktop/scope-extension/src/common/generated/` are produced from these
//! types by `cargo test -p nodu-protocol` (ts-rs `export` derives).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// Request id accepted from the host (`id` may be a string or integer).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub enum RequestId {
    Int(#[ts(type = "number")] i64),
    Str(String),
}

/// Request line from the host: `{id, method, args}`.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub id: RequestId,
    pub method: String,
    pub args: Option<Map<String, Value>>,
}

/// Reply line to the host: `{id, result}` or `{id, error}`.
#[derive(Debug, Clone, Serialize)]
pub struct Reply {
    pub id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Reply {
    pub fn result(id: RequestId, result: Value) -> Self {
        Self {
            id: Some(id),
            result: Some(result),
            error: None,
        }
    }
    pub fn error(id: Option<RequestId>, error: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(error.into()),
        }
    }
}

/// Device-side phase of the shared state snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub enum DevicePhase {
    Disconnected,
    Connecting,
    Connected,
    Running,
    Error,
}

/// Feature flags reported after connect.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct DeviceCapabilities {
    pub repl: bool,
    pub files: bool,
    pub framebuffer: bool,
    pub script: bool,
    /// Firmware prepare/backup/flash path (implemented by the sidecar).
    pub firmware: bool,
}

/// Bounded progress record for long operations.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct ProgressInfo {
    pub stage: String,
    #[ts(type = "number")]
    pub completed: u64,
    #[ts(type = "number")]
    pub total: u64,
    pub percent: u32,
}

/// Live counters for an in-progress `.bin` framebuffer recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct RecordingStatus {
    pub active: bool,
    pub path: String,
    #[ts(type = "number")]
    pub frames: u64,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
}

/// `state` event payload; absent keys mean unchanged from the host's view.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct DeviceState {
    pub phase: DevicePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub board_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub firmware: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub architecture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub board_id: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub protocol: Option<String>,
    pub busy: bool,
    /// Python `flashCapacityVerified` — true only after the reviewed RAM
    /// reader returned a matching JEDEC proof for this connection.
    pub flash_capacity_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub operation: Option<String>,
    pub running: bool,
    pub preview: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recording: Option<RecordingStatus>,
    pub capabilities: DeviceCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub progress: Option<ProgressInfo>,
}

impl Default for DeviceState {
    fn default() -> Self {
        Self {
            phase: DevicePhase::Disconnected,
            port: None,
            board_profile: None,
            flash_capacity_verified: false,
            board_id: None,
            protocol: None,
            firmware: None,
            architecture: None,
            busy: false,
            operation: None,
            running: false,
            preview: false,
            fps: None,
            recording: None,
            capabilities: DeviceCapabilities::default(),
            last_error: None,
            progress: None,
        }
    }
}

/// `log` event payload.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct DeviceLog {
    pub text: String,
    pub stream: LogStream,
    #[ts(type = "number")]
    pub time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub enum LogStream {
    Stdout,
    Stderr,
    System,
}

/// `frame` event payload (JPEG as base64).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct DeviceFrame {
    pub mime: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub time: i64,
}

/// Enumerated serial port.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct SerialPortInfo {
    pub path: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vid: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pid: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub serial_number: Option<String>,
}

/// One board-side directory entry.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
    pub directory: bool,
}

/// `connect` request arguments.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct ConnectArgs {
    pub port: String,
    pub board_profile: String,
    #[serde(default)]
    #[ts(optional)]
    pub baud: Option<u32>,
    /// Original MaixPy IDE board id 0–8 (reset sequence selection).
    #[serde(default)]
    #[ts(optional)]
    pub board_id: Option<u8>,
    /// "ide" (default) or "raw" — raw is kept for migration differential tests.
    #[serde(default)]
    #[ts(optional)]
    pub protocol: Option<String>,
}

/// File content reply (`data` is base64).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct DeviceFileData {
    pub data: String,
    #[ts(type = "number")]
    pub size: u64,
}

/// Prepared firmware plan (kept for protocol compatibility; unused in Phase 1).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct FirmwarePlan {
    pub version: String,
    pub url: String,
    pub sha256: String,
    #[ts(type = "number")]
    pub address: u64,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub write_bytes: u64,
    #[ts(type = "number")]
    pub sector_end: u64,
    pub ready: bool,
}

/// Device backup record (kept for protocol compatibility).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct DeviceBackup {
    pub directory: String,
    pub flash_sha256: String,
    #[ts(type = "number")]
    pub flash_bytes: u64,
    pub verified: bool,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub files: u64,
    pub flash_capacity_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub flash_jedec_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub physical_board_evidence: Option<String>,
}

/// Firmware flash result (kept for protocol compatibility).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = "../../../../scope-extension/src/common/generated/"
)]
pub struct FirmwareResult {
    pub verified: bool,
    pub firmware: String,
    pub backup_directory: String,
    pub sha256: String,
}

/// Event envelope: `{event, data}`.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "lowercase")]
pub enum Event {
    State(DeviceState),
    Log(DeviceLog),
    Frame(DeviceFrame),
}

/// Methods the sidecar accepts (matches the Python worker set).
pub const METHODS: &[&str] = &[
    "getState",
    "listPorts",
    "connect",
    "disconnect",
    "execute",
    "runScript",
    "stop",
    "listFiles",
    "readFile",
    "writeFile",
    "setPreview",
    "startCamera",
    "saveFile",
    "formatScript",
    "resetDevice",
    "startRecording",
    "stopRecording",
    "convertVideo",
    "playVideo",
    "prepareFirmware",
    "backupDevice",
    "flashFirmware",
];

/// Reply for methods the Rust sidecar does not implement yet.
pub const UNIMPLEMENTED_MESSAGE: &str = "此功能将在后续阶段由新设备服务提供。";

/// Request JSON line limit (same as the Python worker).
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_typescript() {
        RequestId::export_all().expect("export wire types");
        DevicePhase::export_all().expect("export phase");
        DeviceCapabilities::export_all().expect("export capabilities");
        ProgressInfo::export_all().expect("export progress");
        DeviceState::export_all().expect("export state");
        RecordingStatus::export_all().expect("export recording status");
        DeviceLog::export_all().expect("export log");
        LogStream::export_all().expect("export log stream");
        DeviceFrame::export_all().expect("export frame");
        SerialPortInfo::export_all().expect("export ports");
        RemoteFile::export_all().expect("export remote file");
        ConnectArgs::export_all().expect("export connect args");
        DeviceFileData::export_all().expect("export file data");
        FirmwarePlan::export_all().expect("export plan");
        DeviceBackup::export_all().expect("export backup");
        FirmwareResult::export_all().expect("export result");
    }

    #[test]
    fn untagged_request_id() {
        let id: RequestId = serde_json::from_str("7").unwrap();
        assert_eq!(id, RequestId::Int(7));
        let id: RequestId = serde_json::from_str("\"abc\"").unwrap();
        assert_eq!(id, RequestId::Str("abc".into()));
    }
}
