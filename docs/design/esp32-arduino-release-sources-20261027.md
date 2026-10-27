# Arduino 离线环境源码与原生工具记录

日期：2026-10-27。范围：Arduino CLI 1.5.1、Arduino-ESP32 Core 3.3.12 的 darwin-arm64 基础运行包。当前交付用于开发环境的离线冷启动验证，**未生成正式安装包，源码发布门槛尚未通过**。

## 已保留的交付资料

- `desktop/scripts/arduino-release-sources.lock.json`：39 个原始源码归档的官方 URL、SHA-256、字节数，以及全部 25 个运行组件的源码覆盖说明。
- `desktop/scripts/collect-arduino-release-sources.py`：按固定清单下载、校验、保留原始许可证、生成 `source-manifest.json`；下载成功不会自动将覆盖状态改成完整。构建机需要 Python 3.11+ 和 curl，用户运行 Nodu 不需要它们。
- `desktop/.tools/arduino-release-sources`：425,136,248 字节原始源码归档，另有 142 份从这些归档中提取的原始许可证文件。归档没有修改，二进制工具不从用户已有安装或缓存中取作发行输入。
- `desktop/scripts/build-arduino-native-ctags.cjs`：从校验过的原始 Arduino ctags 源码构建 Apple Silicon 原生版本；构建结果、许可证与参数位于 `desktop/.tools/arduino-release-native/darwin-arm64`。
- [校验结果与完整 manifest](evidence/esp32-arduino-release-sources-20261027/results.json)、[源码清单快照](evidence/esp32-arduino-release-sources-20261027/source-manifest.json)、[证据校验和](evidence/esp32-arduino-release-sources-20261027/SHA256SUMS)。大体积源码留在 `.tools`，未添加到 Git。

源码打包只允许复制 manifest 的 `files`。`work`、`build`、下载失败的 Go 归档及其他调查材料均不属于发布输入。运行归档的锁定位于 `desktop/scripts/arduino-release.lock.json`，与本源码锁分开保存。

## 覆盖结论

`complete` 仅表示本次指定组件和宿主的源码资料已保留，不代表法律审批，也不承诺所有官方二进制可逐字节重建。当前 5 项为完整、20 项保留缺口，`releaseReady=false`。

| 组件范围 | 数量 | 当前结论 |
| --- | ---: | --- |
| Core 3.3.12 本体 | 1 | 原始 Core、库及构建脚本已保留；单独发布的预编译 SDK 另计 |
| OpenOCD v0.12.0-esp32-20260424 | 1 | macOS 构建脚本与 libusb 1.0.29、hidapi 0.14.0、libjaylink 0.3.1、jimtcl 0.83 的源码已保留；不涵盖其他宿主 |
| mkspiffs、mklittlefs | 2 | 原始项目以及固定 SPIFFS、littlefs 子模块源码已保留 |
| ctags 5.8-arduino11 | 1 | 原始源码、COPYING、原生衍生版本的重建脚本及参数已保留 |
| CLI 和四个 builtin Go 程序 | 5 | 固定 tag 源码已保留，Go 依赖源码尚未完整收集 |
| Xtensa / RISC-V 编译器 | 2 | 真实 GCC、binutils、newlib、picolibc、GNU 配套源码和固定子模块已保留；Rust wrapper 依赖无 Cargo.lock，精确运行库及重建对应关系未核实 |
| Xtensa / RISC-V GDB | 2 | 固定 GDB、子模块和 GNU 配套源码已保留；Rust wrapper、Python/libiconv 构建变体的闭包未核实 |
| esptool 5.3.1 | 1 | 项目源码已保留；冻结 Python 解释器、扩展、依赖版本和 flasher stub 对应源码未闭合 |
| dfu-util 0.11.0-arduino5 | 1 | 上游 0.11 已保留；Arduino5 补丁、交叉构建规则和 libusb 变体未核实 |
| 九个 SoC 的预编译 SDK | 9 | 已记录上游出处，精确 IDF、managed components、预编译 blob 的源码/许可闭包未收集 |

九个 SDK 包分别为 esp32、esp32c3、esp32c5、esp32c6、esp32h2、esp32p4、esp32p4_es、esp32s2、esp32s3。完整组件 ID 和每项缺口见源码锁及 manifest；不要把 Core 源码当成这些 SDK 的完整对应源码。

CLI 源码声明 Go 1.26.1。官方 Go 构建工具的两次限时下载均失败，已停止扩展下载；部分文件不进入 manifest。没有因此替换或重新构建 CLI。这是资料准备的缺口，不是用户运行 Nodu 的安装步骤。

## 对应关系中的两个问题

[Espressif 编译器发布页](https://github.com/espressif/crosstool-NG/releases/tag/esp-14.2.0_20260121) 的 `crosstool-NG-esp-14.2.0_20260121-src.tar.xz` 包含 GCC 15 的 sample 配置，与 GCC 14.2 的该工具版本不一致。因此本清单采用另行固定 SHA 的同名 Git tag 源码及固定 gitlink，保留真实 GCC 14.2.0、binutils 2.43.1、newlib 4.3、picolibc 1.8.10 源码。crosstool-NG 构建脚本本身没有被当成 GCC 完整源码。GMP 6.3.0、MPFR 4.2.1、MPC 1.3.1、ISL 0.26、zlib 1.3.1、zstd 1.5.6 均有原始源码归档与校验值。源码 tag/依赖记录不等于已经重建核实官方二进制。

[Arduino-ESP32 3.3.12](https://github.com/espressif/arduino-esp32/releases/tag/3.3.12) 的打包模板引用 `esp32-arduino-libs-idf-release_v5.5-b774170f-v3.zip`，SHA-256 为 `6650b01ec53cb746cc0e6c7d92b31bffb256617bce552d86e6b24d20dc836121`。上游 `build-packages.sh` 在拆分各 SoC SDK 时去掉 `dependencies.lock` 和 `pioarduino-build.py`。现有拆分归档不足以证明 managed-component 的精确源码版本，因此这九项维持不完整。[模板证据](evidence/esp32-arduino-release-sources-20261027/core-sdk-upstream.json)。

## Apple Silicon ctags

官方 macOS ctags 归档内的可执行文件仅有 x86_64，而 Arduino 常规编译的预处理会调用它。为避免基本编译隐含“先安装 Rosetta”，本次保留官方归档不动，另外构建同一源码版本的 arm64 衍生文件。

原始源码为 [arduino/ctags 5.8-arduino11](https://github.com/arduino/ctags/tree/5.8-arduino11)，归档 SHA-256：`86ca843c62aecb9bc531a73d9b6cef33179bd885b1bf8df9e0c7e9761aa9794d`。未修改 vendor 源码。使用系统 `/usr/bin/clang`，通过预包含 `dirent.h` 和 `stdlib.h` 兼容旧 configure 与现代 SDK；没有伪造 configure 探测结果。完整 CFLAGS、LDFLAGS、configure 参数、Xcode/SDK 版本见 [CTAGS-BUILD.json](evidence/esp32-arduino-release-sources-20261027/CTAGS-BUILD.json)。

结果为 261,944 字节 Mach-O arm64，只链接 `/usr/lib/libSystem.B.dylib`，包含 `+regex`、`+internal-sort`。相同构建机上的两次独立构建 SHA-256 均为 `b765ca33d809b23160a6c953ebcd6f180913a1e02488949efcc49ac1127e18eb`。这不是跨 Xcode 版本的可复现性声明。后续签名改变文件时，应保留 `buildBinarySha256` 并重新计算打包文件 SHA。

采用 CLI 1.5.1 的精确 ctags 参数，对 struct、namespace 函数、多行函数、setup、loop 五条输出进行对照，原生版本与官方 x86_64 版本一致。[对照证据](evidence/esp32-arduino-release-sources-20261027/native-ctags-parity.json)。官方版本只作为行为比较对象，不作为衍生版本的源码或发行输入。

CLI `internal/arduino/builder/internal/preprocessor/ctags.go` 将 `tools.ctags.path` 默认映射至 `runtime.tools.ctags.path` 后再合并平台属性。运行层使用 `platform.local.txt` 指定独立 native 工具目录，可同时覆盖普通编译和语言服务的 gRPC 编译。该配置与离线包接入由主实现维护；此文不把工具构建测试当成最终端到端冷启动验收。

## 校验与交接

运行 `python3 desktop/scripts/collect-arduino-release-sources.test.py -v`：7 项通过，覆盖原始字节保留、相同大小文件篡改、路径穿越/符号链接越界、归档许可证路径越界、缓存时 URL 验证、重复覆盖记录和不完整状态不得自动升级。

运行 `python3 desktop/scripts/collect-arduino-release-sources.py --verify-only --require-complete`：全部 39 个固定源码归档校验通过后，以预期退出码 1 拒绝发布，并列出 20 项缺口；manifest 继续为 `releaseReady=false`。`node --check desktop/scripts/build-arduino-native-ctags.cjs` 通过。

这次不继续追取缺失材料。后续正式分发前应补齐记录中的真实闭包并复核发布规范；开发离线包及冷启动测试可以继续使用当前固定输入，但不能宣称正式源码发布门槛已通过。
