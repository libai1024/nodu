// SPDX-License-Identifier: MIT
//! `nodu-terminal`: standalone serial/TCP/UDP byte terminal for Nodu · 见微.
//! The Theia terminal widget spawns this binary as the shell process.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        print!("{}", nodu_device::terminal::USAGE);
        return ExitCode::SUCCESS;
    }
    match nodu_device::terminal::parse(&args) {
        Err(e) => {
            eprintln!("nodu-terminal: {e}");
            eprintln!("nodu-terminal: try --help");
            ExitCode::from(2)
        }
        Ok(options) => match nodu_device::terminal::run(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("nodu-terminal: {e}");
                ExitCode::FAILURE
            }
        },
    }
}
