# Nodu 开发入口

[产品说明](../README.md) · [当前版本](../VERSION) · [文档导航](../docs/README.md)

本目录是应用源码。安装包使用者不需要安装以下开发依赖。已安装版本的架构、签名和实测范围以对应 Release 为准。

## 环境

- Node.js **24.x** 与 npm，启动器会检查 Node 主版本。
- Python 3、Git、Rust / rustup。
- macOS：Xcode Command Line Tools，媒体构建需要可用的 `clang`、`make` 等系统开发工具。默认原生构建生成 Apple Silicon 与 Intel 两个架构；Apple Silicon 上执行 x64 构建工具时需要 Rosetta。
- Windows：x64 Node、MSVC C++ 构建工具和 Windows SDK。在 Windows 本机执行 Windows 打包，不使用 macOS 产物替代。

Rust 版本在 [native/rust-toolchain.toml](native/rust-toolchain.toml) 中固定。图像 WASM 的 `wasm-bindgen-cli` 必须与 [native/Cargo.lock](native/Cargo.lock) 完全匹配，当前为 `0.2.129`。

macOS 初次准备，在本目录执行：

```sh
npm ci
npm exec -- install-electron
cd native
rustup show
rustup target add aarch64-apple-darwin x86_64-apple-darwin wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
cd ..
```

Windows 使用 `x86_64-pc-windows-msvc` 与 `wasm32-unknown-unknown`，不要使用 Apple 目标作为替代。

## 构建与启动

```sh
npm run build:electron
npm run start:electron
```

完整构建生成 Rust 侧车、媒体组件、图像 WASM、固定版本 clangd 插件与 Electron 应用。首次构建可能下载较大的依赖或源码归档，缓存仍需通过摘要校验。不指定项目时进入工作台；也可传入自己的项目：

```sh
npm run start:electron -- /absolute/path/to/project
```

使用保留的 Python 设备适配路径时，可执行 `npm run setup:device`。它在用户目录创建独立 Python 环境，不是 STM32 工具链安装器。

浏览器开发目标使用 `npm run build:browser` 与 `npm run start:browser`；它不能代替 Electron 的工作台、原生窗口和打包验收。两个目标共享原生 Node 依赖，切换时按脚本重建 ABI，先保存正在编辑的文件。

## 额外资源

### STM32 工具包

应用需要包含 Arm GNU、CMake、Ninja、OpenOCD、stm32flash、clangd 与对应 HAL / CMSIS 的工具包。通过清单校验后使用，不从全局 PATH 随意选择其他版本。

- 开发用生成器：[scripts/build-toolkit.cjs](scripts/build-toolkit.cjs)。先按 [P0 工具准备](../tools/stm32-p0/README.md#准备工具与-sdk)获取锁定版本；脚本接收 `--p0-local`、`--homebrew` 与 `--clangd` 参数，目前仅实现 macOS 开发配置。
- 开发包默认输出 `.tools/stm32/darwin/`；可通过 `NODU_STM32_TOOLKIT` 显式选择完整工具包。
- 发布包必须使用 `profile=release`，包含许可与对应源码归档，通过 [package-stm32.cjs](scripts/package-stm32.cjs) 检查。不能把开发包中的 Xcode / Homebrew 文件改标签当作发布工具包。

[工具包分发设计](../docs/0.2.1/TOOLKIT-DISTRIBUTION.md)记录布局与来源，其中标为设计的步骤不代表已自动完成。

### 教学纯函数检查

macOS 按当前架构准备固定版本工具：

```sh
npm run prepare:tutor-tools
npm run test:tutor-tools
```

脚本使用 [tutor-tools.lock.json](scripts/tutor-tools.lock.json) 校验归档。Universal 打包需同时准备 `darwin-arm64` 与 `darwin-x64`，可分别传入 `-- --arch arm64` 与 `-- --arch x64`。当前 Windows 的纯函数执行因进程树隔离尚未接入而返回不可用。[执行说明](../docs/ai-tutor/PURE-FUNCTION-CHECKS.md)记录范围与复测方法。

## 检查与打包

```sh
npm run compile --workspace @scope/studio-extension
npm run check:brand
npm run test:launcher --workspace @scope/studio-extension
npm run test:tutor --workspace @scope/studio-extension
node --test scope-extension/test/brand-theme.cjs
```

真实原生检查器和 WASI 回归需要已生成资源，分别运行 `test:tutor-native`、`test:tutor-wasi` 工作区脚本。固件编译、实板烧录、串口和模型测试另行验收。

准备好工具包、示例、媒体、许可材料与应用构建后：

```sh
npm run package:electron -- --help
npm run package:electron
```

默认在 macOS 生成 Universal `.app` 与 ZIP，在 Windows 生成 x64 便携 ZIP；macOS 可指定 `-- --arch arm64` 或 `-- --arch x64` 生成单架构应用。缺少资源或清单不合规时会停止。打包代码只做 ad-hoc 签名，不代表完成 Apple Developer ID 签名、公证或 Windows Authenticode。

打包所需的上游示例由 `npm run vendor:examples` 准备，该命令要求匹配固定提交的来源仓库。请阅读 [第三方组件说明](THIRD-PARTY-NOTICES.md)，保留随包许可证、修改记录与对应源码材料。当前采用本地构建和人工上传，暂不配置 CI/CD；旧工作流仅作为 [停用示例](../docs/build/workflow-examples/)保存。
