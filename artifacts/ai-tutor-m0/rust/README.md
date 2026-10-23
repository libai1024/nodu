# Isolated C parser probe

Run from the repository root:

```sh
artifacts/ai-tutor-m0/rust/run.sh
```

Requires the existing Rust 1.98 toolchain and the repository's installed TypeScript compiler. Cargo dependencies are pinned by this probe's own lockfile. No application workspace or lockfile is changed.

`checked` means a bounded syntactic observation of the known `receive` return value against `HAL_OK`, not a semantic proof, AI review, or course completion. Unsupported preprocessor constructs, function-pointer cases, delegated returns and incomplete code return `unknown`. The probe intentionally lacks whole-program analysis and is not a production checker.

The 19 fixtures cover positive/reversed/multiline/assigned checks, ignored returns, comment/string false matches, similar names, macros, function pointers, incomplete blocks, return propagation, overwritten variables, unknown conventions, multiple calls, Unicode offsets and ordinary pointer parameters. `ts-rs` declarations are compiled against an actual serialized result by the local TypeScript compiler.
