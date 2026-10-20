// SPDX-License-Identifier: MIT
// `nodu-resources`: version-check / resource-install sidecar. JSON lines on
// stdout — {"event":"progress",...} during downloads, then one {"result"}
// or {"error"}. Cancelling stdin (EOF) aborts a download with
// {"error":"cancelled"} and removes the temp/staging residue; the previous
// resources are never touched by a failed or cancelled install.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use nodu_resources as lib;
use nodu_resources::Version;

const USAGE: &str = "nodu-resources — resource version check / install sidecar

usage: nodu-resources <command> [options]

commands:
  check-version   --url <u> --current <x.y.z>
  check-resources --url <u> --installed <x.y.z>
  install --url-template <t> --version <x.y.z> --dest <dir>
          --version-file <p> [--sha256]
  reset --bundled <dir> --dest <dir> --version <x.y.z> --version-file <p>

stdout: {\"event\":\"progress\",...} then one {\"result\"} or {\"error\"}.
stdin EOF cancels an in-flight install (temp files removed).";

fn flag_value(args: &[String], name: &str) -> Result<String, String> {
    let at = args
        .iter()
        .position(|a| a == name)
        .ok_or_else(|| format!("{name} is required"))?;
    args.get(at + 1)
        .cloned()
        .ok_or_else(|| format!("{name} requires a value"))
}

fn flag_version(args: &[String], name: &str) -> Result<Version, String> {
    let value = flag_value(args, name)?;
    Version::parse(&value).ok_or_else(|| format!("{name} expects x.y.z, got {value:?}"))
}

fn check_unused(args: &[String], used: &[&str], bare: &[&str]) -> Result<(), String> {
    let mut i = 1usize; // args[0] is the subcommand
    while i < args.len() {
        let arg = &args[i];
        if bare.contains(&arg.as_str()) {
            i += 1;
        } else if used.contains(&arg.as_str()) {
            i += 2; // every value flag takes one value
        } else {
            return Err(format!("unknown argument {arg:?}"));
        }
    }
    Ok(())
}

fn emit(value: serde_json::Value) {
    println!("{value}");
}

/// stdin EOF flips the flag: the Node caller closes stdin to cancel. The
/// download loop polls it between chunks.
fn stdin_cancel() -> impl Fn() -> bool {
    let flag = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&flag);
    thread::spawn(move || {
        let mut buf = [0u8; 256];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => {
                    eprintln!("nodu-resources: stdin EOF -> cancel");
                    seen.store(true, Ordering::Relaxed);
                    return;
                }
                Err(e) => {
                    eprintln!("nodu-resources: stdin read error {e:?} -> cancel");
                    seen.store(true, Ordering::Relaxed);
                    return;
                }
                Ok(_) => {}
            }
        }
    });
    move || flag.load(Ordering::Relaxed)
}

fn run(args: &[String]) -> Result<serde_json::Value, lib::Error> {
    let command = args.first().map(String::as_str).unwrap_or("");
    match command {
        "check-version" | "check-resources" => {
            let current_name = if command == "check-version" {
                "--current"
            } else {
                "--installed"
            };
            check_unused(args, &["--url", current_name], &[]).map_err(lib::Error::msg)?;
            let url = flag_value(args, "--url").map_err(lib::Error::msg)?;
            let current = flag_version(args, current_name).map_err(lib::Error::msg)?;
            let result = lib::check(&url, current)?;
            Ok(serde_json::json!({
                "latest": result.latest.to_string(),
                "newer": result.newer,
            }))
        }
        "install" => {
            check_unused(
                args,
                &["--url-template", "--version", "--dest", "--version-file"],
                &["--sha256"],
            )
            .map_err(lib::Error::msg)?;
            let template = flag_value(args, "--url-template").map_err(lib::Error::msg)?;
            let version = flag_version(args, "--version").map_err(lib::Error::msg)?;
            let dest = PathBuf::from(flag_value(args, "--dest").map_err(lib::Error::msg)?);
            let version_file =
                PathBuf::from(flag_value(args, "--version-file").map_err(lib::Error::msg)?);
            let require_sha = args.iter().any(|a| a == "--sha256");
            let cancel = stdin_cancel();
            lib::install(
                &template,
                version,
                &dest,
                &version_file,
                require_sha,
                &|event| match event {
                    lib::InstallEvent::Progress { downloaded, total } => emit(serde_json::json!({
                        "event": "progress",
                        "downloaded": downloaded,
                        "total": total,
                    })),
                    lib::InstallEvent::Phase(phase) => emit(serde_json::json!({
                        "event": "phase",
                        "phase": phase,
                    })),
                },
                &cancel,
            )?;
            Ok(serde_json::json!({ "installed": version.to_string() }))
        }
        "reset" => {
            check_unused(
                args,
                &["--bundled", "--dest", "--version", "--version-file"],
                &[],
            )
            .map_err(lib::Error::msg)?;
            let bundled = PathBuf::from(flag_value(args, "--bundled").map_err(lib::Error::msg)?);
            let dest = PathBuf::from(flag_value(args, "--dest").map_err(lib::Error::msg)?);
            let version = flag_version(args, "--version").map_err(lib::Error::msg)?;
            let version_file =
                PathBuf::from(flag_value(args, "--version-file").map_err(lib::Error::msg)?);
            lib::reset(&bundled, &dest, &version_file, version)?;
            Ok(serde_json::json!({ "installed": version.to_string() }))
        }
        other => Err(lib::Error::msg(format!(
            "unknown command {other:?}; try --help"
        ))),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match run(&args) {
        Ok(result) => {
            emit(serde_json::json!({ "result": result }));
            ExitCode::SUCCESS
        }
        Err(lib::Error::Cancelled) => {
            emit(serde_json::json!({ "error": "cancelled" }));
            ExitCode::FAILURE
        }
        Err(e) => {
            emit(serde_json::json!({ "error": e.to_string() }));
            ExitCode::FAILURE
        }
    }
}
