// SPDX-License-Identifier: MIT
//! `nodu-kflash` — Rust port of the Python flash/backup stack:
//!
//! * `nodu_flash_protocol.py` → [`codec`] (bounded SLIP/packet/JEDEC codec),
//! * `nodu_firmware.py` → [`firmware`] + [`kfpkg`] + [`deflate`] + [`pyjson`],
//! * `nodu_flash_probe.py` → [`probe`],
//! * `kflash.py` 1.1.6 loader paths → [`kflash`],
//! * worker backup stream helpers → [`backup`].
//!
//! Layering: codec/deflate/pyjson/crc32 are pure; probe/kflash drive a
//! `nodu_serial::Transport`; orchestration stays in `nodu-device`, which is
//! the only owner of the port lock and session state — exactly like the
//! Python worker.

pub mod backup;
pub mod codec;
pub mod crc32;
pub mod deflate;
pub mod error;
pub mod firmware;
pub mod kflash;
pub mod kfpkg;
pub mod probe;
pub mod pyjson;

pub use error::{ErrorKind, FlashError, Result};
