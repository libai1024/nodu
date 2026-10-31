# Windows 完整离线包：2026-10-31

本批次 Windows x64 完整离线安装包已完成实际安装、离线编译、S3 真板和语言服务验收。仓库公开，可匿名访问；macOS 与 Linux 不继承本批次结论。最终程序来自干净提交 `045821917629235eba0a1dbafbf1300ba7ccf913`。

## 固定材料与来源

Windows 对应材料锁文件覆盖 25 个发布组件。原始归档与许可证保留在随包 Arduino offline `sources` 目录；每个文件记录 HTTPS 来源、长度、SHA-256，构建前重新验证。许可证从归档原样提取，保留完整归档成员路径及来源目录；修复平铺 ZIP 的根许可证与嵌套依赖许可证同名覆盖，并拒绝大小写不敏感路径冲突。组件注册表未提供文件的两项，使用其 `idf_component.yml` 指定提交的上游仓库许可证。

- GCC：保留实际 GCC、binutils、newlib、picolibc、crosstool-NG 标签和固定子模块。Windows 包装器中的 Rust 提交对应 1.86.0，依赖路径对应 lazy_static 1.5.0；Rust 原始源码包含 vendored 依赖。libc 调用仅在 Unix 配置编译，附加保留两个上游构建上下文版本。
- dfu-util：确认 Arduino 定制源码是 `bcmi-labs/dfu-util@3a18dc1d`，不是未修改的基础 0.11。其中 configure.ac 仍显示 Arduino4，与二进制一致；Arduino5 的工作流、crossbuild 0.2.2 和实际 libusb 1.0.26 源码均保留。
- esptool：官方 Windows 包中的 CPython 为 3.13.14。17 个 Python 发行版逐一与 PyPI 文件核对：Python 模块使用相同解释器编译，仅归一化文件名后比较代码对象；原生扩展逐字节摘要一致。结果见 [依赖比较](python-dependency-comparison.json)。PyInstaller 6.11.1 的五个 loader 模块全部一致，也符合当时 Espressif 构建 action 的固定版本。补充 CPython 外部依赖、cryptography 所用 OpenSSL 4.0.1、libyaml 0.2.5，以及 cryptography/tibs Cargo.lock 的校验和固定依赖源码。
- SDK：保留 ESP-IDF b774170f、23 个直接 gitlink、三个嵌套 gitlink、摄像头及 57 个托管组件原包。官方 [lib-builder run 35150420889](https://github.com/espressif/esp32-arduino-lib-builder/actions/runs/35150420889) 记录 builder 6671d0bd、IDF 提交及最终 SDK 上传；摘要见 [构建来源](sdk-provenance.txt)。九个 SDK 的运行时归档由独立 bundle 校验逐个核对完整 SHA-256。

`complete` 表示该发行组件所需源码及声明材料已保留，不表示能逐字节重建第三方签名 EXE，也不表示 Espressif 仅以二进制提供的无线固件、模型等已开源。原厂二进制组件保留其许可条件；产品界面仍仅支持 ESP32-C3/S3。

## 公开仓库检查

Gitleaks 8.30.1 扫描全部本地 Git 历史（139 个提交）。158 个提示经复核均为源码/提交摘要、测试假密钥、快捷键或本地编译关联编号，没有未解决项；见 [复核记录](secrets-triage.json)。公开前另核对历史模型设置截图，API Key 输入为空。没有将本地缓存、用户配置或安装包加入 Git。

## 构建与验收记录

材料收集器的离线测试覆盖原始文件保留、同长度篡改拒绝、路径越界拒绝、未完成审查不自动升级、独立许可证不能代替源码。打包器保持干净提交检查、主机范围检查及正式资源检查，不使用 validation 模式生成正式发行。

实际安装器包含本地分卷合并、全卷摘要核验和驱动步骤，已安装到 `D:\Nodu-Full-0.2.3-Test`，初始 Data 为空，安装退出码 0，版本、profile 与源码身份一致。未复用旧验证目录。原始安装及载荷身份见 [安装结果](installed-identity.json)、[安装器 manifest](installer-manifest.json)、[载荷 manifest](portable-manifest.json)。

| 成品测试 | 结果与证据 |
| --- | --- |
| S3 COM4 两轮编译、烧写、复位运行 | 两份不同固件均成功，16 MB Flash / 8 MB OPI PSRAM；[硬件结果](hardware-result.json) |
| 串口 | 两轮 ASCII、中文、4200 字符回显通过，烧写后恢复监视器，关闭重开后通信通过 |
| C3/S3 常用库 | 全部 11 个库同工程编译、预期错误检测、修复重编译通过；[软件结果](software-result.json) |
| C3/S3 编辑器语言服务 | 各 91 项补全、定义跳转、悬停、未保存诊断、12 次 Unicode 编辑和整页替换映射通过；[LSP 结果](lsp-result.json) |
| STM32F103 | 五组成功编译、故意语法错误及恢复；[编译结果](f103-acceptance.json)、[clangd 结果](f103-language-acceptance.json) |
| 最终程序启动与目录 | 应用后端启动、HTML 返回 200、所有可写目录位于本地 Data；[隔离验收](clean-package-acceptance.json) |

S3 的首次 Arduino 环境准备耗时 185.3 秒，另有共享嵌入式服务的首次准备；这是本地解包，不是下载。后续 C3/S3 重开环境检查分别为 1.355 / 1.369 秒。语言服务整页替换并保存后重建为 32.7 / 34.5 秒，不能把本次通过解读成所有编辑操作都即时完成。

Arduino 编译与硬件测试通过动态 WFP 阻断 Nodu 和 Arduino CLI 外网，证明返回 EACCES；不声称单独阻断所有编译器子进程。STM32 测试另外阻断记录中的构建程序；PATH 只有 Windows 系统目录，没有开发机工具。测试结束动态规则已移除，无测试进程残留。S3 测试脚本为仓库 `desktop/scripts/esp32-s3-hardware-acceptance.cjs`；[本次常用库脚本](software-acceptance.cjs) 使用同目录的仓库 `packaged-arduino-acceptance-loader.cjs`，从未改写安装包中的程序。

安装器与三个分卷已上传 GitHub，服务器给出的大小与 SHA-256 均匹配本地，见 [附件核验](github-assets.json)。正式下载与全部文件摘要见 [0.2.3 发布说明](../../releases/0.2.3.md)。

C3 尚无实体板，不标为真板验收通过；本次没有 STM32 实体烧写。Windows 11、其他 S3 板型和原生 USB 未另验收。驱动由 Windows 管理系统目录；应用、工具、工程和缓存均使用非 C 盘目录。此前设备记录见 [S3 COM 记录](../windows-esp32-s3-com-20261029/README.md)。
