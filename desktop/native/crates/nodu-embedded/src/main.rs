// SPDX-License-Identifier: MIT
//! `nodu-embedded` binary: see the library documentation.

use std::path::PathBuf;

const USAGE: &str = "nodu-embedded — stdio JSON-lines STM32 service

usage: nodu-embedded --resources <dir> --toolkit <dir> --data-dir <dir>

  --resources <dir>   scope-extension/resources/stm32 (chips, boards, templates)
  --toolkit <dir>     STM32 toolkit root (toolkit.json); NODU_STM32_TOOLKIT overrides
  --data-dir <dir>    user data (backups, trusted projects, toolkit check)
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        print!("{USAGE}");
        return;
    }
    let mut resources = None;
    let mut toolkit = None;
    let mut data_dir = None;
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1).map(PathBuf::from);
        match args[i].as_str() {
            "--resources" => resources = value,
            "--toolkit" => toolkit = value,
            "--data-dir" => data_dir = value,
            other => {
                eprintln!("nodu-embedded: unknown argument {other:?}; try --help");
                std::process::exit(2);
            }
        }
        i += 2;
    }
    let Some(resources) = resources else {
        eprintln!("nodu-embedded: --resources is required; try --help");
        std::process::exit(2);
    };
    let toolkit = std::env::var_os("NODU_STM32_TOOLKIT").map(PathBuf::from).or(toolkit).unwrap_or_default();
    let data_dir = data_dir.unwrap_or_else(|| {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join(".nodu")
    });
    let service = nodu_embedded::service::Service::new(resources, toolkit, data_dir, Box::new(std::io::stdout()));
    service.serve(std::io::stdin().lock());
}
