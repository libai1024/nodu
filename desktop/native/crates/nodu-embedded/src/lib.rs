// SPDX-License-Identifier: MIT
//! `nodu-embedded`: stdio JSON-lines service for STM32 HAL projects
//! (docs/0.2.1/FUNCTIONAL-DESIGN.md §10). Project creation, CMake builds with
//! Chinese diagnostics, the artifact store, ST-LINK and serial ISP downloads
//! with first-write backups and read-back, and the serial monitor.

pub mod build;
pub mod catalog;
pub mod diag;
pub mod flash;
pub mod locks;
pub mod monitor;
pub mod probes;
pub mod process;
pub mod project;
pub mod proto;
pub mod service;
pub mod stlink;
pub mod toolkit;
pub mod uart;
pub mod util;
