# STM32 发布工具包

2026-10-24：`prepare-stm32-release.py` 为 macOS Apple Silicon 生成独立的 `2026.10.24` 工具包。它不修改开发工具包，也不把 Xcode 或 Homebrew 的现有程序复制进安装包。

## 输入与产物

- Arm GNU 14.2.rel1、CMake 4.4.3、Ninja 1.13.2、clangd 23.1.0 使用官方归档。
- OpenOCD 0.12.0、libusb 1.0.29、stm32flash 0.7 从固定原始源码构建；Xcode 仅作为构建编译器使用。OpenOCD 保留 ST-LINK 与 libusb 支持，不引入 Homebrew 动态库、J-Link、FTDI 或 Capstone 依赖。
- `desktop/scripts/stm32-release.lock.json` 固定上游地址、字节数与 SHA-256。Arm 源码摘要来自官方 `.sha256asc`；GitHub 二进制摘要与发布资产记录核对。
- `desktop/scripts/stm32-sdk.lock.json` 固定 CubeF1/CubeF4、HAL、CMSIS Device 的提交以及 401 个实际 SDK 文件。首次引入时每个文件的 Git blob 与 ST 官方固定提交逐一核对；准备时再验证大小及 SHA-256。
- 完整 Arm 对应源码、OpenOCD（含 JimTcl）、libusb、stm32flash 及 Ninja 源码归档随工具包放在 `sources/`。构建脚本、锁文件及原始许可一同保留。原始源码没有补丁；libusb 以可替换动态库分发。
- 工具均检查 Mach-O 架构与动态依赖，完成 ad-hoc 签名，再生成最终文件摘要。`profile: release` 只由此完整准备流程生成。

## 本地准备

需要 macOS Apple Silicon、Python 3.12 或更新版本、Xcode Command Line Tools。首次下载需要网络。输出目录必须不存在，以免覆盖已有工具包。

```sh
python3 desktop/scripts/prepare-stm32-release.py \
  --cache /absolute/path/stm32-downloads \
  --out /absolute/path/toolkits/darwin-arm64
```

可以添加 `--sdk-source /absolute/path/sdk` 复用已有 SDK 文件，但每个文件仍必须匹配官方锁。`--offline` 要求所有归档和 SDK 文件已在缓存中，缺失或摘要错误即失败。`--work-dir` 指定可复用的源码构建目录。

```sh
node -e "require('./desktop/scripts/package-stm32.cjs').validateToolkit('/absolute/path/toolkits/darwin-arm64')"
NODU_STM32_RELEASE_TOOLKITS=/absolute/path/toolkits \
  npm --prefix desktop run package:electron -- --arch arm64
```

`licenses/BUILD-EVIDENCE.json` 记录程序版本与运行依赖；`toolkit.json` 记录实际分发文件和源码归档摘要。源代码归档约 312 MB，应随安装包保留，不能在压缩前删掉以缩小体积。

## 验证边界

准备工具只执行编译、版本查询和不存在的测试端口校验，不识别、复位或烧写设备。离线 F103/F407 工程编译通过不代表对应硬件已经验证。工具包自身的 ad-hoc 签名也不代表 Apple Developer ID 签名或公证。

本次 arm64 产物通过发布清单校验；41 个 Mach-O 的最低系统版本均不超过 macOS 15。F103C8/F407ZG 的 P0 编译 BIN 与旧基线 SHA-256 完全相同；两套正式课程的 starter/reference 四份副本通过产品 sidecar 编译，均为零错误、零警告。官方 clangd 使用新工具包的交叉编译配置检查 F103 C 文件通过。输入校验与解包测试 4 项、发布门禁测试 1 项通过。以上均为离线检查，没有打开真实串口或操作 ST-LINK。

当前 macOS 准备脚本只支持 arm64。Windows 由独立脚本准备；不能把 macOS 工具或开发 profile 改名后用于另一个平台。既有 universal 打包入口要求两种架构都具备正式工具包，不能用单架构工具代替。
