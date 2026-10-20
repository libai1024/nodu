# macOS universal 侧车（X1.1 部分证据）

日期：2026-10-20。

## 构建

- `rustup target add x86_64-apple-darwin --toolchain 1.98.1-aarch64-apple-darwin`
  （注意：workspace 由 `rust-toolchain.toml` 固定 1.98.1，target 必须装到该
  toolchain，而不是 default stable。）
- `scripts/build-native.cjs` 改为 macOS 双 target（aarch64-apple-darwin、
  x86_64-apple-darwin）构建 + `lipo -create` 合成 universal，同时 stage 到
  `resources/bin/darwin-arm64/` 与 `resources/bin/darwin-x64/`（现有按
  `platform-arch` 查找的路径不变）。
- 环境注入 `MACOSX_DEPLOYMENT_TARGET=15.0`，与媒体包 `minos<=15.0` 门禁一致。

## 验证（本机 arm64 + Rosetta）

- `lipo -info`：`darwin-*/nodu-device`、`darwin-*/nodu-terminal` 均含
  `x86_64 arm64` 双切片。
- `otool -l`：`minos 15.0`（sdk 26.5）。
- `arch -x86_64 darwin-x64/nodu-device --help` 在 Rosetta 下实际运行成功，
  说明 x86_64 切片可执行，不只是编译通过。
- 全依赖树（serialport、crossterm、tokio 等）无 unsafe FFI 目标受限项，
  x86_64 交叉编译零错误。

## 未验证

- 真正的 macOS 15 机器（arm64 或 x64）运行；Intel Mac 无 Rosetta 场景；
  universal Electron 应用打包（ffmpeg universal、签名、公证仍属阶段 8）。
