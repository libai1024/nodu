# Arduino 离线发行资源

Nodu 的基础 Arduino 环境随软件下载交付。用户不需要另装 Arduino IDE、运行命令或在首次使用时下载开发板支持包。当前固定组合为 Arduino CLI **1.5.1**、Arduino-ESP32 **3.3.12**，基础目标为 ESP32-C3 / ESP32-S3；不提供后台更新开发板索引或自动切换 Core 的路径。调整固定版本需要重新制作并验收 Nodu 发行资源。

## 构建期输入

`prepare-arduino-release.cjs` 只在制作 Nodu 时运行，接收官方索引快照与已下载归档。`--download` 仅允许构建者补齐清单中锁定的官方归档，不是用户首次运行的下载动作。

```sh
npm run prepare:arduino-release -- \
  --host darwin-arm64 \
  --cache-home /path/to/official/arduino-cache \
  --sources-dir .tools/arduino-release-sources \
  --native-dir .tools/arduino-release-native/darwin-arm64
```

允许重复 `--cache-home` 复用多个只读下载缓存；`--index-home` 指定索引快照来源。CLI、Core、每项 Core 依赖和 CLI 自带的发现工具均校验固定大小与 SHA-256。`arduino-release.lock.json` 锁住全部支持主机的官方归档 URL、文件名、大小、SHA-256，索引里同版本的内容发生变化时构建直接失败。构建不会复制生产者的 Arduino 配置、已安装工具树、编译缓存、项目或用户路径。

默认产物位于 `.tools/arduino-release/<host>`，不进入 Git。可使用 `--output` 改变单主机产物位置。正式打包从该目录读取；`NODU_ARDUINO_RELEASE_BUNDLES` 可覆盖其父目录。macOS universal 包要求 arm64 与 x64 的全部发行材料分别通过校验。

## 随包布局

```text
resources/arduino/offline/
  required.json
  <host>/
    manifest.json
    cli/                         # 原始官方 CLI 归档
    data/                        # 索引快照、可迁移的 profile Core 源文件
    downloads/packages/          # 原始官方 Core 和完整工具依赖归档
    native/                      # Apple Silicon 原生 Arduino ctags 与重建资料
    sources/                     # 发行源码及许可材料
```

`required.json` 由正式打包步骤产生；缺包、错版本或资源损坏不应退回网络安装。运行时只把清单允许的目标复制到 Nodu 自己的环境目录，源码和许可不进入执行目录。已有用户索引及额外库如何保留由运行时模块负责，不能覆盖用户 Arduino IDE 环境。

Arduino CLI 的 profile 冷安装会另建临时索引目录并尝试联网。因此包内直接包含从已验证官方 Core ZIP 提取的源文件，以及根据同一官方索引生成的 `installed.json`，写入固定、与用户路径无关的 profile ID。其余工具归档仍交由官方 CLI 解压安装；不修改官方 Core 的依赖集合以缩小包。Core 3.3.12 同时声明了其他芯片预编译库和调试工具，基础包必须保留这份依赖闭包，但不代表 Nodu 已对这些额外芯片或调试功能作过产品验收。

## Apple Silicon

官方 Arduino ctags 5.8-arduino11 的 macOS 归档仅含 Intel 程序。Nodu 使用同版本、未修改的公开源代码构建 arm64 ctags，并保留构建脚本、来源哈希、许可证和构建记录。

`platform.local.txt` 只覆盖 `tools.ctags.path`，通过相对的 `{runtime.platform.path}` 定位 Nodu 自带工具。原始 `platform.txt` 不变，路径随应用环境移动。原始官方 ctags 归档也保留，供 CLI 完成自己的资源初始化；实际预处理使用 Nodu 原生版本。验收需要禁止执行官方 Intel ctags，以防本机已有 Rosetta 掩盖外部依赖。

锁定 CLI 的主机匹配规则不识别 `aarch64-apple-darwin`，因此 mklittlefs 依赖必须带其实际选择的 x64 原始归档。当前普通编译、串口烧录不调用 mklittlefs、mkspiffs 或 dfu-util；这些文件存在不等于对应功能已完成无 Rosetta 验收。

原生 ctags 在 macOS 内层代码签名后字节会改变。打包器在外层应用签名前更新清单中的原生文件哈希和大小，同时保留 `buildBinarySha256` 与源码来源；压缩归档与 Core 源文件的原始校验值不变。

## 发行门槛与验证

- 每个主机的完整运行资源必须存在，全部文件经过校验。
- 每个交付组件都有已审核的对应源码/许可覆盖记录。`source-manifest.json` 的 `coverage.complete` 表示该组件的材料闭包已核对，不是“下载到了一个仓库压缩包”。缺失项保持 `releaseReady: false`，正式打包拒绝继续。测试可显式检查尚未完成分发材料的本地运行包，但不得把它当作可发布安装包。
- 空 Nodu 用户目录、禁止网络、禁止读取开发者现有 Arduino 与 Homebrew 环境；新建 C3/S3 工程，以随包 CLI 和编译器完成默认 11 库的实际编译。
- Apple Silicon 同时禁止执行 Intel ctags，验证原生工具和可迁移配置确实参与构建。
- 使用当前固定版本继续运行已有工程，不联网更新开发板索引。额外库的显式安装与基础环境是独立能力。

执行脚本：`npm run test:arduino-package`。冷启动实际编译脚本：`arduino-offline.e2e.cjs`。正式安装包与物理 USB 烧录仍需各自验收，源码包或本地脚本测试不能替代它们。

## Windows 本地 ESP32 验证目录

Windows 的对应材料使用独立锁文件，避免把 macOS 上游构建依赖的审查结果用于 Windows：

```sh
python3 scripts/collect-arduino-release-sources.py \
  --lock scripts/arduino-release-sources.win32-x64.lock.json \
  --out .tools/arduino-release-sources-win32 --require-complete
```

2026-10-30 该锁仍有未完成项，此命令应失败；不得通过修改标记或使用本地验证模式生成正式包。材料齐全后，`prepare-arduino-release.cjs --host win32-x64 --sources-dir .tools/arduino-release-sources-win32 ...` 才能用于正式构建。完整包还要求 `NODU_WINDOWS_DRIVERS` 和 `NODU_ESP32_WINDOWS_DRIVERS`，分别指向完整的 ST-LINK、CH343 签名驱动目录。

正式完整包的便携目录为 `dist/Nodu-win32-x64`。在 Windows 上通过 `package-windows-installer.cjs --portable <该目录> --nsis <makensis.exe>` 制作安装器。超过 1900 MiB 的 ZIP 会拆成 `.zip.001`、`.zip.002` 等文件，每卷最多 1536 MiB；安装器及全部分卷必须放在同一目录。安装时先逐卷校验并合并，再校验整包摘要，全程不下载文件。上传时同时提供安装器、全部分卷、manifest 与 SHA-256 文件；原始大 ZIP 可用于百度网盘，不能直接作为超过 GitHub 单附件限制的 Release 文件。

`node scripts/package-electron.cjs --profile esp32-validation` 仅供本地硬件验收。它仍校验全部运行文件的大小、哈希、版本和清单闭包，但显式允许对应源码材料尚未齐全的资源。默认 `full` 的发行校验保持严格；本模式不会生成 ZIP 或安装器，不应用于上传正式发行。

在 Windows 构建机准备固定 Arduino bundle、ALS、clangd 和启动器后，可用 `NODU_ARDUINO_RELEASE_BUNDLES` 指定资源根目录。`NODU_ESP32_WINDOWS_DRIVERS` 可指向用 Windows `pnputil /export-driver` 导出的已签名 CH343 驱动目录；只复制文件，需要时由管理员执行随包脚本安装。

产物 `dist/Nodu-ESP32-Validation-win32-x64` 包含 `LOCAL-VALIDATION-ONLY.json` 和 `NoduPortable.json`。标记内明确保留 `arduinoReleaseReady: false`；运行数据、工程、Arduino 环境和共享嵌入式服务均放在同目录 `Data`。目录整体移动后仍从包内读取工具，不依赖构建机安装的 Node 或 Python。

`esp32-s3-hardware-acceptance.cjs` 是需要明确开启的真板测试：设置 `NODU_S3_TEST_ROOT`、`NODU_S3_TEST_PORT` 和 `NODU_S3_ALLOW_FLASH=1`。未打包编译目录可用 `NODU_S3_TEST_EXTENSION` 指定扩展；Electron 成品应设置 `NODU_S3_PACKAGED_APP=<应用目录>/resources/app`，由验收加载器读取未修改的生产后端模块工厂，使用应用自身的 `Nodu.exe`（`ELECTRON_RUN_AS_NODE=1`）运行，无需另外提供 Node 依赖。程序会覆盖所选 S3 的固件。测试先走产品首次打开工程的初始化流程；固件只操作串口，使用 16 KiB UART 接收缓冲并按换行累积消息，验证两份不同固件、Flash/PSRAM、监视器恢复、中文及 4200 字符回显。`NODU_S3_OFFLINE_GUARD` 可指定动态 WFP 验证工具，从空 Arduino home 检查本次运行的 Node/Electron 和 CLI 外网连接被拒绝；它不声称覆盖每个编译器子进程。
