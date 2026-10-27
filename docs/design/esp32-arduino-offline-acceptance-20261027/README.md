# Arduino 随应用交付：冷启动离线验收

日期：2026-10-27。平台：macOS Apple Silicon。结论：**基础运行环境的冷启动离线验收通过；正式发布资源包尚未就绪。**

本记录验证真实 Nodu 后端和发布资源组件，不是完整 `.app` 安装包验收，也没有打开任何物理串口。当前 bundle 的 `releaseReady` 仍为 `false`：对应源材料 5 项完成、20 项尚有交付缺口，发布脚本应继续拒绝正式打包。这个限制与下面已经通过的离线运行能力分别记录。

## 测试条件

- 由 `desktop/scripts/arduino-offline.e2e.cjs` 创建全新 `/private/tmp/nodu-arduino-offline-z4vng7/home`，没有复制任何已安装工具、库或编译缓存。
- 整个测试进程及其子进程运行在 macOS `sandbox-exec` 的 `deny network*` 策略下。直接连接 `127.0.0.1` 和 `1.1.1.1` 都必须返回 `EPERM`；这两个探针不依赖 DNS 失败来证明断网。
- 子进程 `PATH` 只保留系统路径；拒绝读取用户 Arduino15、Arduino IDE、Homebrew CLI、原有 bysj Arduino 环境和上轮测试缓存。
- Arduino CLI、官方 Core、工具和索引来自 `desktop/.tools/arduino-release/darwin-arm64`；11 个常用库来自 Nodu 已有的内置库资源。没有把环境变量指向原有 Arduino 安装。
- 禁止执行官方旧的 Intel `builtin/tools/ctags/5.8-arduino11/ctags`。检查新 ctags 的 Mach-O 头为 ARM64，并记录 `file`、版本和 `platform.local.txt`；真实编译在此限制下完成。
- 创建 C3、S3 两个标准 Nodu 工程，保留生成的 11 个固定库引用；项目父目录包含空格。

## 结果

| 步骤 | 结果 | 实测耗时 |
|---|---|---:|
| C3 首次打开：从空 home 初始化本地资源 | 通过 | 60.102 秒 |
| C3 首次编译：全部 11 库的组合源码 | 通过 | 72.827 秒 |
| S3 在新服务实例中打开，同一 Nodu 环境 | 通过 | 15.784 秒 |
| S3 首次编译：全部 11 库的组合源码 | 通过 | 81.600 秒 |
| 再次新建服务实例，重新编译 C3 | 通过 | CLI 编译 40.868 秒 |

这些是本机测试耗时，不是性能承诺。首次打开仍需要本地展开与初始化，约一分钟；可以确认不需要再联网下载环境，不能把这一结果表述为零等待。

打开前，测试刻意在用户源码末尾写入未完成的函数声明。`inspect` 初始化成功后，源码 SHA-256 和完整 `sketch.yaml` 均未变化；准备过程使用应用自己的临时工程。随后测试自行恢复有效源码再进行编译。两个项目打开后语言服务配置均返回 `ok: true`，CLI 指向新的 Nodu `home/bin`，ALS 指向应用内置工具。这里验证的是语言服务启动配置，不重复宣称已在这个冷启动进程里完成编辑器补全交互验收。

10 条真实 CLI 调用全部使用新的 `home/bin/1.5.1/darwin-arm64/arduino-cli`。最终日志没有 `Error initializing instance`、`Download failed` 或 `Error downloading`。所有网络均被系统拒绝，因此不存在成功的外部下载；CLI 的 `Downloading ... already downloaded` 是复用随包归档的输出，不代表发生联网下载。

- C3：程序占用 497,668 字节，静态 RAM 22,924 字节；应用 `.bin` 大小 497,808 字节。
- S3：程序占用 472,649 字节，静态 RAM 31,704 字节；应用 `.bin` 大小 472,800 字节。
- 两芯片均生成应用、bootloader、分区表和 4 MiB 合并映像；具体 SHA-256 见 `final/result.json`。
- 原生 ctags SHA-256：`b765ca33d809b23160a6c953ebcd6f180913a1e02488949efcc49ac1127e18eb`。
- 测试进程退出码 0，没有遗留测试进程；见 `final/cleanup.json`。
- 冷测完成时的 Arduino 回归 **117/117** 通过，原始输出保留在 `final/arduino-regression.log`。随后审计补充固定索引恢复、窗口关闭取消初始化与准备状态检查，Arduino 与启动台合并回归 **137/137** 通过，见 `final/arduino-regression-after-audit.log`；这是后续自动化回归，没有把上述冷启动实测冒称为后审版本的再次全量冷测。发布脚本回归 **24/24** 的独立证据见 [发布组件验收](../evidence/esp32-arduino-offline-package-20261027/)。

## 保留的失败与修复

`initial-before-fix/` 保留首轮失败。它使用系统临时目录创建独立空 home，同样禁止网络和原有环境读取；当时尚未增加禁止 Intel ctags 的策略。

1. 发布资源选择了 ARM mklittlefs 归档，但固定版本 CLI 实际选择 Intel 兼容条目，因缺少对应归档尝试联网，立即被拒。
2. 官方库索引快照缺少固定的 Adafruit GFX Library 1.13.0。只有归档没有可解析索引时，库仍无法安装。
3. `--only-compilation-database` 在上述缺依赖条件下返回 0，并在日志报告错误；原来的初始化因此错误显示就绪，随后真实组合编译失败。

修复后，资源选择与固定 CLI 保持一致，内置库版本合并进现有索引，初始化额外检查 CLI 错误与生成结果。又补充原生 ARM64 ctags，避免开发机已有 Rosetta 掩盖发布依赖。`final/` 是修复后全新 home 的完整重测，不是修补旧 home 后的重编。

## 证据与复现

- `final/result.json`：隔离条件、10 次 CLI 调用、两项目打开与编译结果、固件校验值。
- `final/runner.cjs`、`sandbox.sb`、`launch.json`、`worker.log`：实际运行脚本快照、系统策略和启动记录。
- `final/*.log`、`*.ino`、`*.sketch.yaml`、`*.build.options.json`：原始输出和输入配置。
- `final/bundle-after-source-update.json`：测试中发布代理只追加源码材料；运行文件记录的 SHA-256 前后均为 `80009251bbeea91e49c48d3a3645f208378d33c0dfec94d07931b942cda00c33`，与验收内容一致。最终 manifest SHA-256 为 `9c98a645dc82f7aa80157cceba2b41d9d95d0f74801d4905eef669400f2fbef3`。
- `SHA256SUMS`：本目录证据完整性清单。

在仓库根目录、已经编译 Nodu 扩展且准备好资源后运行：

```sh
node desktop/scripts/arduino-offline.e2e.cjs --bundles desktop/.tools/arduino-release
```

脚本每次新建独立目录，不接受复用原有 home。当前执行策略明确限定 macOS ARM64。Windows、Linux、Intel macOS、完整安装包以及物理 USB/烧写测试不由本记录覆盖。
