// SPDX-License-Identifier: MIT
// Error classes for the flash/backup port: the Python modules raise
// `nodu_flash_protocol.ProtocolError` (a ValueError), `nodu_firmware.
// FirmwareError`, `nodu_flash_probe.ProbeError`, the worker's
// `DeviceError`/`Cancelled`, and kflash's local `TimeoutError`. The distinct
// kinds matter because probe() catches exactly (ProbeError, codec
// ProtocolError) and BackupReceiver records type(exc).__name__ diagnostics.

use std::fmt;
use std::io;

use nodu_repl::ReplError;

/// Which Python exception class an error corresponds to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// `nodu_flash_protocol.ProtocolError` (a ValueError subclass).
    Protocol,
    /// `nodu_flash_probe.ProbeError`.
    Probe,
    /// `nodu_firmware.FirmwareError`.
    Firmware,
    /// The worker's `DeviceError` (and pyserial/I/O failures).
    Device,
    /// The worker's `Cancelled`.
    Cancelled,
    /// kflash's local `TimeoutError` (a bare Exception subclass).
    Timeout,
}

impl ErrorKind {
    /// `type(exc).__name__` for diagnostics (`errorType`/`causeType` fields).
    pub fn type_name(self) -> &'static str {
        match self {
            Self::Protocol => "ProtocolError",
            Self::Probe => "ProbeError",
            Self::Firmware => "FirmwareError",
            Self::Device => "DeviceError",
            Self::Cancelled => "Cancelled",
            Self::Timeout => "TimeoutError",
        }
    }
}

/// A flash-path failure carrying its Python exception class and message.
#[derive(Debug)]
pub struct FlashError {
    kind: ErrorKind,
    message: String,
    /// `__cause__` class name when Python wrapped another exception
    /// (`FirmwareError(...) from exc`); diagnostics only.
    cause: Option<&'static str>,
}

impl FlashError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            cause: None,
        }
    }
    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Protocol, message)
    }
    pub fn probe(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Probe, message)
    }
    pub fn firmware(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Firmware, message)
    }
    pub fn device(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Device, message)
    }
    /// kflash's bare `TimeoutError`; its `str(exc)` is empty so the worker's
    /// `str(exc) or exc.__class__.__name__` yields the class name.
    pub fn timeout() -> Self {
        Self::new(ErrorKind::Timeout, "TimeoutError")
    }
    /// Firmware errors Python wraps `from exc` keep the inner class name.
    pub fn with_cause(mut self, cause: &'static str) -> Self {
        self.cause = Some(cause);
        self
    }
    pub fn kind(&self) -> ErrorKind {
        self.kind
    }
    pub fn cause(&self) -> Option<&'static str> {
        self.cause
    }
    /// Python probe() catches exactly (ProbeError, protocol.ProtocolError).
    pub fn is_probe_reportable(&self) -> bool {
        matches!(self.kind, ErrorKind::Probe | ErrorKind::Protocol)
    }
    pub fn is_cancelled(&self) -> bool {
        self.kind == ErrorKind::Cancelled
    }
    /// Message text (`str(exc)`).
    pub fn message(&self) -> &str {
        &self.message
    }
    /// Mutate the message (Python `exc.args = (new,)`) preserving the class.
    pub fn set_message(&mut self, message: String) {
        self.message = message;
    }
    /// Worker boundary: codec ProtocolError maps to the worker's
    /// `ProtocolError` (phase=error); other classes surface as DeviceError.
    pub fn into_repl(self) -> ReplError {
        match self.kind {
            ErrorKind::Protocol => ReplError::protocol(self.message),
            ErrorKind::Cancelled => ReplError::Cancelled(self.message),
            ErrorKind::Timeout => ReplError::timeout(self.message),
            ErrorKind::Probe | ErrorKind::Firmware | ErrorKind::Device => {
                ReplError::device(self.message)
            }
        }
    }
    /// Map a worker `check()`/session error into this crate's taxonomy.
    /// The worker's `ProtocolError` is a `DeviceError` subclass — never the
    /// codec `ProtocolError` probe() would annotate — so it lands on Device.
    pub fn from_repl(error: ReplError) -> Self {
        match error {
            ReplError::Cancelled(m) => Self::new(ErrorKind::Cancelled, m),
            ReplError::Device(m) | ReplError::Protocol(m) | ReplError::Timeout(m) => {
                Self::new(ErrorKind::Device, m)
            }
        }
    }
}

impl fmt::Display for FlashError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FlashError {}

impl From<io::Error> for FlashError {
    fn from(e: io::Error) -> Self {
        Self::device(if e.to_string().is_empty() {
            "serial I/O failed".to_string()
        } else {
            e.to_string()
        })
    }
}

impl From<ReplError> for FlashError {
    fn from(e: ReplError) -> Self {
        Self::from_repl(e)
    }
}

pub type Result<T> = std::result::Result<T, FlashError>;
