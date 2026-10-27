# Arduino 编辑器服务验收

日期：2026-10-27。执行环境：macOS arm64、Node 24、Arduino CLI 1.5.1、ESP32 Core 3.3.12。范围为 Arduino ESP32-C3 / S3，未涉及 ESP-IDF 或物理 USB。

## 实现

- 独立 Nodu Arduino 插件使用 Arduino Language Server 0.7.7-nodu.1 与 LLVM clangd 21.1.8。`.ino` 预处理、自动函数声明和坐标映射由 ALS 完成；插件只注册 C++ 语法高亮与语言客户端，不把 `.ino` 重命名为 `.cpp`。
- 新增 cpp 语言扩展名 `.ino` / `.pde`；实际应用未带 C++ grammar，因此随插件补入官方 VS Code 1.105.1 C++/macro TextMate grammar 与语言配置（MIT，固定来源/逐文件 SHA）；用户显式语言关联优先。插件仅在当前 Arduino 项目环境已准备且空闲时启动。
- CLI、Core、库与构建选项读取同一个隔离 home 和 `sketch.yaml`。项目/板卡/库版本变化重新启动，启动错误进入现有问题与重试流程；离开项目或关闭应用停止。
- 命令和路径按参数传递；clangd 的 GCC 查询仅允许 Nodu 的 `data/packages/**` 和 profile 的 `data/internal/**`。不放开任意工作区的编译器执行。
- 上游 ALS 仅传 `data/packages/**`；profile 编译器在 `data/internal/**`，因此 Nodu 提供启动器追加两个受控根。macOS 启动器同时设置空 `SDKROOT`，避免 LLVM clangd 自动附加 Xcode 的主机 SDK，导致 Xtensa 正确代码误报 `architecture not supported`。不更改用户 `.clangd` 或源文件。
- Theia 1.76 的语言提供器 RPC 丢失 `RelativePattern.baseUri`；客户端改用转义后的项目绝对 glob，保持项目范围，并避免补全、定义、重命名提供器注册崩溃。
- 真实 Electron 暴露的 `workspace/semanticTokens/refresh` panic 来自现代客户端的默认能力声明超过 ALS 0.7.7 的代理范围。新增最后执行的能力过滤，关闭未代理的 refresh、动态注册、workspace/configuration、workspace/applyEdit、showDocument 请求声明；继续保留 ALS 支持的补全、悬停、定义、重命名与推送诊断，该能力过滤与后述源码补丁独立，补丁后仍保留。
- 第二处实际崩溃是 ALS 未实现 `workspace/didChangeWatchedFiles`。文件监视器改为由插件处理：打开文档使用正常 didChange/didSave，新增/删除源文件与未打开头文件的外部变动以 500 ms 合并后重启当前会话；过滤 `.nodu`、build、`.git` 等生成目录。普通保存不重启，也不把未实现通知发送给 ALS。
- 上游响应还误声明 workspaceSymbol、executeCommand 和 onTypeFormatting；插件注册前移除这三项。依赖 clangd.applyFix/applyTweak 的命令式 CodeAction 不暴露，直接文本 edit、显式格式化保留。这些功能不能算作本轮已实现。
- 深入测试发现官方 `go.bug.st/lsp v0.1.3` 把 UTF-8 byte offset 当作 UTF-16 character，中文/emoji 行会误删后续内部缓存；mapper 的 `dirty ||` 短路还漏更新多行坐标。本轮从官方 0.7.7 制作 `0.7.7-nodu.1`：仅修这两处，保留补丁、原始来源、完整修改源码及固定 vendor、回归测试和可复现构建。普通已识别函数体内 Unicode、回车、多行粘贴使用真实增量，不修改磁盘文本或尾换行。
- 跨多个预处理原型的大替换仍会触发上游 alias 原地搬移冲突，两个小补丁不冒充全面修复。客户端因此只对明确的简单顶层函数体启用快速路径；顶层声明/函数签名/include、namespace/class/全局 initializer、复杂宏/条件编译/续行、raw string、CRLF 转换及不确定词法边界采用精确全文重同步。单行数字/字符串对象常量（例如 LED_PIN、SERIAL_BAUD）允许快速路径。180 ms 合并连续粘贴/撤销/重做为每个文档的最新全文；保存先冲刷待同步文档。
- 仅当工具清单版本、修改源码/补丁摘要与实际二进制 SHA 同时匹配时启用新路径；自定义/未知 ALS 仍使用保守兼容方案。重同步期间补全/悬停等待最新 `arduinoLanguageServerRebuild` begin/end，90 秒超时明确报错，服务停止/切换释放等待。原 Unicode 失败和两处补丁后的 prototype-alias 失败分别保留于验收数据的 `unicode-before-fix/` 与 `prototype-alias-before-conservative-boundary/`。

- `file:///not-ino` 上游工具诊断进入 Arduino 编辑器输出；真实 `.ino` 诊断原样显示，不伪造文件或隐藏编译错误。

## 已执行测试

| 项目 | C3 | S3 |
|---|---|---|
| 启动真实 ALS 0.7.7-nodu.1，LSP initialize | 通过 | 通过 |
| 固定 profile 的 ArduinoJson 7.4.3 悬停，第 6 行 | 通过 | 通过 |
| Serial 成员补全 | 91 项，含 println | 91 项，含 println |
| 本地函数定义跳转 | 原 `.ino` 第 3 行 | 原 `.ino` 第 3 行 |
| 正确源码的错误诊断数 | 0 | 0 |
| 未保存增量编辑的 missing_function 诊断 | 原 `.ino` 第 11 行 | 原 `.ino` 第 11 行 |
| 函数体内多行粘贴后当前变量悬停 | 56 ms，原第 12 行正确 | 78 ms，原第 12 行正确 |
| 40 ms 间隔的中文 + emoji 增量编辑后当前悬停 | 12 次共 565 ms | 12 次共 566 ms |
| 以上编辑后整份替换并保存，等待实际预处理 | 13.9 s，新第 7 行悬停 / 补全正确 | 17.7 s，新第 7 行悬停 / 补全正确 |
| 编辑后磁盘源码保持原值 | 通过 | 通过 |
| 正常关闭与进程回收 | 通过 | 通过 |

独立测试 7/7 通过，覆盖路径引号、canonical home、受限查询范围、SDKROOT、profile 不变、配置指纹变化、缺失工具、延迟启动、重复启动复用、环境隔离、切换和销毁、真实/工具诊断分流、Windows 单反斜杠路径与 glob 转义、能力过滤保留必要补全、文件事件节流、未实现提供器屏蔽与 CodeAction 过滤、UTF-16 文本保持、无尾换行、粘贴/撤销、最新重建门控。另以真实 TextMate + Oniguruma 验证 `#include`、`void`、字符串和中文注释的不同 token scope，逐文件 grammar 摘要匹配。TypeScript 编译通过。

原始 LSP 消息、结果、源代码和工具摘要记录在 [验收数据](esp32-language-acceptance-20261027/result.json)，文件摘要在 [manifest.json](esp32-language-acceptance-20261027/manifest.json)。实际 Electron 暴露的桥接、语言关联/grammar、两个未实现协议入口问题均已作针对修复；整体 GUI 复验以 `arduino-electron-acceptance-20261027/` 的最终结果为准，本文件不把纯协议用例当作 GUI 稳定验收。

复验入口：先准备隔离 `NODU_ARDUINO_HOME`，在 desktop 执行 `npm run test:arduino-language`；真实协议用例执行 `npm run test:arduino-language:e2e -- --incremental --evidence=<目录>`，另以 `--edge-only` 验证无尾换行、同一行 emoji 和撤销；`--raw-incremental` 可重现未限制的上游 prototype-alias 缺陷。用例只创建临时工程并启动 LSP，不打开任何串口。工具准备、插件构建已接入 `build:browser` / `build:electron` / `build:plugins`；普通编译不重复下载工具。

## GUI 因果同步修正与最终协议重放

最终 GUI 复验曾发现真实错误：注释末尾 Enter 后继续粘贴两行，当前第 17 行 JsonDocument 的 hover 一度返回旧行的 serializeJson。对应现场保留于 `arduino-electron-acceptance-20261027/27-patched-multiline-wrong-hover-initial.png`、`patched-multiline-wrong-hover.ino` 与 `lsp-patched-mapping.txt`，没有把后台重建后最终恢复当作增量通过。

定点分析确认此序列在 patched Go mapper 中逐步增量更新本身正确。客户端最小文本差异落在下一行注释前，过于保守的 `/` 边界检查把普通 Enter 错判为全文重同步；旧后台 rebuild 的 begin/end 又可能在排队与实际 flush 之间被当成新 epoch，过早放行请求。修正仅涉及客户端：准确识别注释 Return 与真正截断 token 的边界；语义请求先等待 `syncChain`、冲刷待重同步，再等待实际 flush 新标记的最新索引。保存遵循同一顺序，180 ms 合并仍保留。LanguageClient 9.0.1 本身会捕获通知版本，不额外改写它。

最终测试新增 `--middleware --gui-sequence --chips=esp32c3`：直接加载产品的同一 adapter middleware（包括真实延迟队列、flush 和 gate）驱动真实 ALS，采用捕获的 GUI 文档与两步事件。此测试没有把理想同步 send 冒充实际中间件路径。

| 真实 middleware + ALS 步骤 | 结果 |
|---|---|
| Enter 后位于编辑点之后的 JsonDocument / serializeJson / loop | 当前第 15 / 18 / 22 行，全部内容和 range 正确，76 ms |
| 随后两行 paste 后同三处符号 | 当前第 17 / 20 / 24 行，全部内容和 range 正确，92 ms |
| 已有真实后台 rebuild begin 时整文 paste → undo → redo | 等待 32.36 s，返回最终第 19 / 22 / 26 行；无旧结果提前放行 |
| ESP32-C3 / S3 无末尾换行、同一行 emoji 前缀 | 补全列 34、真实错误列 27，准确 |
| 两芯片撤销后当前符号 / 旧诊断消除 / 未保存磁盘不变 | 全部通过 |

原始协议输出见验收数据的 `middleware/` 与 `edges/`；独立 Go mapper GUI 重放另留 `gui-mapper-replay/`。单测还人为把旧 begin 放在排队后、flush 前，再送旧 end，断言请求仍不得放行；同时断言悬停不能越过尚未发送完成的增量。

保留官方 didChange/didSave 的后台预处理调度：自动保存后仍可能显示 Building sketch，普通已知增量可在其运行时返回语义。没有通过丢弃保存通知来隐藏索引工作。完整实际 GUI 最终结论仍以 Electron 验收记录为准。

## 固定工具及来源

| 材料 | 版本 | SHA-256 |
|---|---|---|
| ALS macOS ARM64 官方归档 | 0.7.7 | `77f3a9fa71bd4c61dd293c6b623cebfaf424f6b794ede1a7b042e9b42a76e4c5` |
| 修改版 ALS ARM64 二进制 | 0.7.7-nodu.1 | `2fa517a13d97da0f3ed5656bb92da367cc7c3b90a2217749970181498595a0ec` |
| 修改版 ALS x64 二进制 | 0.7.7-nodu.1 | `b53192e13a46a712d876791697b236bee128ef39fc5fb54a0ef8c172583397ba` |
| 修改版源码（含 vendor 与回归） | 0.7.7-nodu.1 | `8ceb2428d0ad435452b339bfea8d8ff0cdc67fa513b8619fb6dfa498e56ef5d6` |
| 两处源码补丁 | nodu.1 | `f8a04eac99e89c0ff3532d5f03c945be7a83a978d5f70affd7cd065923c48c92` |
| 构建时 Go ARM64 官方归档 | 1.24.1 | `295581b5619acc92f5106e5bcb05c51869337eb19742fdfa6c8346c18e78ff88` |
| ALS macOS x64 官方归档 | 0.7.7 | `c86b838efe247d45d32f585696af9aa114d5527a2cfc52cdcac1845343bc4a3b` |
| clangd macOS 官方归档 | 21.1.8 | `b435e8eff9bb8db59d6f0f874b3a6b1cfaaa94980e08e38f0fa015dde185d36d` |
| clangd macOS 二进制（官方 universal） | 21.1.8 | `1d37030fb652202d6b6884d3451ae2d6db279139ecf289c713e07e65f52d9237` |
| ALS 官方 tag 源码归档 | 0.7.7 | `8a236e5165090a688b1d13f06288130b4413e354671c1ada3463a526d2513528` |

ALS 为 AGPL-3.0，保留原始官方许可/源归档与修改版完整对应源码（含 go.mod/go.sum、vendor 原许可、变更声明、新增 Go 回归）；clangd 为 Apache-2.0 WITH LLVM-exception，保留完整发行目录内建头文件及许可证。两者为独立子进程。Nodu 的 MIT 许可不替代这些材料的许可。插件使用锁定的 vscode-languageclient 9.0.1；依赖版本、MIT/ISC 等许可与 bundle hash 随插件生成，不需要用户运行 npm。

ALS 使用固定 Go 1.24.1 从修改版源码离线 vendor 构建；所有 Go 包及显式 vendored textedits 回归通过。原工作目录与归档解包后两次 ARM64 构建二进制 SHA 完全相同。`build-arduino-language-server.cjs` 验证源包/补丁摘要并使用 `-trimpath -buildvcs=false -mod=vendor` 与固定版本/日期。构建目录执行过程不需要用户系统安装 Go。原始来源是 [ALS 官方 0.7.7](https://github.com/arduino/arduino-language-server/releases/tag/0.7.7) ；[clangd 官方 21.1.8](https://github.com/clangd/clangd/releases/tag/21.1.8) 保持官方发行，下载先验证固定 SHA-256。完整 URL、各平台归档摘要在 `resources/arduino/language/tools.json`；二进制实际摘要在每个 host 的 `ARDUINO-LANGUAGE-TOOLS.json`。macOS SDK 行为的依据是 [clangd 21.1.8 CompileCommands.cpp](https://github.com/llvm/llvm-project/blob/llvmorg-21.1.8/clang-tools-extra/clangd/CompileCommands.cpp) 的 `detectSysroot`；查询范围依据 [clangd system headers](https://clangd.llvm.org/guides/system-headers)。

## 平台边界

- darwin-arm64：实际下载、摘要、双芯片编译环境与真实 LSP 验证通过。
- darwin-x64：修改版 ALS 已交叉构建，universal clangd 已核验并产出包资源；未在 Intel Mac 运行完整 LSP 用例。
- win32-x64、linux-x64：固定源码/Go/clangd配置与构建入口已提供，未在对应系统执行全链路验收。Windows 启动器需 Windows C 编译器（MSVC `CC=cl` 或 clang）；macOS 不伪造其 `.exe`。
- Linux ARM64、Windows ARM64 尚无此版本组合的验收包；构建明确失败，不复用不兼容二进制。普通用户不需要安装 npm、Xcode 或 C 编译器；发行包构建机负责这些工具。首次环境未准备时返回真实缺失状态，避免声称补全已经可用。
- 普通已识别函数体的实际增量已达上述毫秒级响应；顶层/复杂预处理变化仍需 CLI 重索引。最终暖缓存协议测得 13.9–17.7 s，重建重叠用例为 32.36 s，并行运行的另一轮为 47.46 s；旧官方保守方案在真实 GUI 连续更改中曾接近 98 s。不能把快路径数字推广到初次索引、复杂宏、全部 Arduino 编辑或所有硬件。
- 更新可执行文件必须用新 inode 原子替换：测试中原地覆盖 clangd 复现 macOS exit 137；构建脚本已改临时目录/改名替换，当前两个 macOS clangd 的 `--version` 实际通过。

## macOS 签名后的工具摘要

打包流程会重签内部 Mach-O，从而改变 ALS 字节 SHA。新增 `package-arduino-language.cjs` 在内部工具签名后、外层 app 封装签名前刷新 `binarySha256`，并保留原始 `buildBinarySha256`、修改源码/补丁/上游来源摘要；否则安装版会误退回未知 ALS 的保守同步。原始发行资源未修改。独立测试在临时副本执行真实 codesign、严格验证签名，确认字节确实改变且清单与新字节匹配、原 build/source/patch 身份保留，错误 source 身份会拒绝更新。测试入口 `npm run test:arduino-language:package`，1/1 通过。此测试没有生成或验收完整安装包，不代表 Developer ID 签名或 notarization 已完成。

## 最终 Electron 观测

最新插件 813317 bytes 的真实 GUI 原失败序列已通过：Enter 后 JsonDocument 第 15 行；两行粘贴后 JsonDocument 第 17 行、serializeJson 第 20 行、loop 第 24 行均正确，命令到可读结果约 0.5 s。已有后台 Building sketch 时整文替换/撤销/重做，6.7 s 与 22.6 s 仍保持门控，46.6 s 观察到最终第 19 行 JsonDocument，随后 serializeJson 第 22 行、loop 第 26 行正确；实际缺失函数诊断落在新第 23 行。GUI截图在相邻 Electron 验收目录 29–34 号文件。

仍保留一项瞬时观测：编辑后的 AX 树中曾短暂出现 outline 的 `selectionRange must be contained in fullRange` 内部 Error 条目，下一次 hover 观察即消失；没有 toast，也没有导致错误悬停或语义阻断，未有独立可视截图确认该项。来源为 Theia DocumentSymbol 范围验证与上游暂时无效的符号范围；没有为隐藏日志而泛吞错误或伪造行号，也不声称所有 symbol 服务完全无瞬态。整文 undo/redo 中另记录一次临时 invalid range 日志，门控期间没有向用户返回旧语义，重建后已按新行号恢复。
