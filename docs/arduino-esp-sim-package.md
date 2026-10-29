# Arduino 仿真产物导出模块

2026-10-27。实现入口：`desktop/scope-extension/src/node/nodu-arduino-simulation-package.ts`。目标格式为 Study Studio `packages/contracts/esp-sim/format.md` 的 `.esp-sim.zip` v1。

第一阶段增加了独立生产者模块与独立测试；第二阶段已把它接入 Arduino server、连接 RPC、编译成功状态、项目/更多菜单与现有开发板设置。真实服务构建测试使用 `NoduArduinoServer.compile`，成功令牌由同一进程的服务 Map 解析；不是把其他 CLI 探针包装成 Nodu 构建。代码已接线不等于原生桌面点击验收通过，分层证据见文末。

## 桌面操作与服务接线

在现有开发板设置的“仿真配置”中明确选择当前芯片的固定配置。C3 为 4 MB / 160 MHz / UART0 / CDC 关闭；S3 为 8 MB / 240 MHz / UART0 / CDC 与 PSRAM 关闭 / 主循环与事件 Core 1。未选择时保留现有实际开发板参数，打开工程和普通编译不自动套用预设。

“项目 → 导出仿真包…”与专业模式“更多 → 导出仿真包…”复用同一操作。参数不符时给出开发板设置入口和具体不匹配项；符合时选择新文件，再执行保存当前工程 → 准备真实 profile → 捕获编译前内容 → 正式编译 → 解析成功 token → 校验并原子导出。取消保存对话框、切换工程、保存失败、编译时修改源码、编译失败或取消，都不会进入后续发布。

`compile({path,operationId,simulation:true})` 强制在正式编译前通过官方 CLI 完成 profile 准备，然后由服务自行调用 `discover` 与 `capture`。普通编译保持原有语义；当固定配置和现有依赖已满足时也保存快照，缺少导出证据仅记录 `simulationError`，不伪造编译失败。成功 Map 内保存 snapshot 与真实编译输出，失败/新构建使旧 token 失效。日志沿用既有服务的 8 MiB 有界输出上限。

`exportSimulation({path,operationId,buildToken,destination})` 不接受客户端依赖列表或构建目录。服务重新查询 token，校验项目、FQBN、源码和产物，再调用包生产者复核依赖。它与编译/配置/库修改共享现有操作互斥；连接断开会取消该连接拥有的导出，其他连接不能取消它。目标只创建新文件，已有文件返回可操作的中文错误；拒绝保存到会参与源码扫描的工程目录，允许工程外或工程 `.nodu` / `build` 中的新文件。原子文件发布是提交点，没有额外写入“当前包”指针；已有历史包保持独立可移交。

## 调用顺序

1. 使用既有准备流程安装当前 profile 的固定 Core、工具与库。初次构建可先调用 `prepare`；不要在捕获内容快照以后安装或修改依赖。
2. `discoverArduinoSimulationDependencies(home, projectPath, cliPath)` 从实际官方安装记录、缓存归档、库 `library.properties` 与 profile 解析依赖来源。它不下载、不安装，也不从产物包或日志执行命令。该默认发现器当前面向官方 CLI profile 的 `data/internal` 布局；其他安装布局可由服务传入经过验证的 `ArduinoSimulationDependency[]`，不能猜测目录。
3. `captureArduinoSimulationInputs({projectPath, dependencies, producerVersion, cliVersion, coreVersion, idfVersion, signal})` 在正式编译前计算源码、外部本地库、已安装依赖内容与实际归档的摘要。返回的 snapshot 是进程内不可伪造的对象；复制 JSON、应用重启或只有历史令牌都不能替代它。服务应把 snapshot 与随后成功构建绑定。
4. 正式调用既有 `compile`。仅对 `ok=true`、非 stale、非 cancelled 的当前成功令牌继续。解析成功 Map 得到 `{token,path,directory,digest,artifacts,fqbn}`，不要接受客户端传来的构建目录、摘要或“成功”文字。
5. `createArduinoSimulationPackage({snapshot, build, buildLog, verifyCurrent, signal})` 返回包字节、manifest、逐文件内容摘要 `contentDigest`、ZIP 字节摘要、ELF 与完整 Flash 摘要。`verifyCurrent` 必须重新查成功令牌，校验当前工程、完整 FQBN、输入摘要和产物摘要；失败、撤销或新构建替换令牌都应拒绝。
6. `publishArduinoSimulationPackage(result, absoluteNewPath, verifyCurrent, signal)` 原子创建新的历史包文件。它再次核对源码、产物、依赖与取消状态，不覆盖任何既有目标，不写“当前构建”状态。当前服务保留自己的工程/窗口操作锁，仅发布新文件，不另存 current 引用；旧成功包保持可读，失败和取消不产生新的当前结果。

服务把真实构建输出保留为 `buildLog`，而不是只写“成功”。本模块检查日志非空，但它不能鉴别一个不可信调用者伪造的日志或 producer 版本；可信的调用方是 Nodu 服务，客户端只提交工程身份、令牌及明确选择的输出文件。内容摘要说明包内一致性，不是数字签名或构建证明。

## 固定目标与包内容

仅接受 Arduino-ESP32 3.3.12、IDF 5.5.5、Arduino CLI 1.5.1；C3 为 160 MHz/4 MiB，S3 为 240 MHz/8 MiB、LoopCore=EventsCore=1、PSRAM disabled；串口为 UART0，USB CDC on boot 关闭。需要完整 FQBN 和实际选项，拒绝默认推断。

保留原始 ELF、application/bootloader/partition/OTA/merged BIN、`build.options.json`、`flash_args`、真实日志，以及源文件快照和依赖锁。偏移来自实际 `flash_args`；缺少任何段或 merged 都拒绝，不补引导、不猜分区、不重编译、不修改固件。模块验证 chip 镜像、ELF ISA、应用描述符内完整 ELF SHA-256、IDF 版本，以及原始 merged 与四段重建的逐字节一致性。接收方仍必须执行 Studio 的完整验证，包括 ELF 节、分区 MD5、OTA 状态与包结构校验。

FQBN `FlashMode=qio` 与实际 Arduino `flash_args`/镜像中的 `dio` 分别保存。不能改写产物以强行令两者同名。

源码与构建身份来自真实文件；不会读取源码来纠正接线，不写学生内存，不生成模拟串口结果。包校验成功不代表任何器件仿真、接线或原生桌面验收已经通过。

## 依赖、许可与摘要

默认发现器记录整个 profile 中直接和传递库、本地目录库、Core 及其声明工具依赖。对当前芯片的编译器、SDK、esptool、Core 和项目库计算安装目录内容摘要；对平台声明但本目标未使用的其他工具计算实际缓存归档 SHA-256，并与本地官方安装记录的 SHA-256 对照。记录中的 `relationship` 明确区别这两种关系，不把“安装了”视为“参与链接”。构建输出仍是实际库使用情况的依据。

`installed-tree-v1` 对目录中所有普通文件生成 `{type:"file",sha256,size}`；包内普通文件的符号链接生成 `{type:"symlink",target,sha256,size}`，越出依赖根目录或指向目录的链接拒绝。相对路径按字节对应的字符串顺序排序后，将路径到记录的 JSON（无空白，UTF-8）取 SHA-256。该算法不依赖修改时间、绝对安装路径或 ZIP 压缩流。重检查会再次读取内容，不能用 mtime 充当内容锁。源码 `sourceDigest` 使用 Studio v1 的路径到文件 SHA-256 算法，另保留 Nodu 已有 `arduinoInputDigest` 绑定。

不根据库名猜许可证。未进行语义许可判断的项标记 `NOASSERTION`；目录内找到的 LICENSE/COPYING/NOTICE 文件保存路径、字节数与 SHA-256 作为审核线索。归档未展开分析时明确保留许可待审，不声称完成再分发审查。依赖字节本身不进入包，模拟器不安装依赖；锁定文件不是对所有系统库和编译环境的完整 SBOM 声明。

ZIP 成员使用稳定排序、固定时间、普通文件权限及 deflate。`contentDigest` 是包内全部文件路径与内容 SHA-256 的规范 JSON 摘要；`packageSha256` 只是这一 ZIP 的字节身份。构建 token 和 input snapshot ID 是真实运行身份，因此不同构建的包即使程序行为相同也不承诺相同 contentDigest。

## 测试和证据

独立测试入口：`desktop/scope-extension/test/arduino-simulation-package.cjs`。它仅将新 TS 模块在内存转译，复用当前扩展已有编译服务，不改写已有 `lib/` 文件。测试必须使用独立 home，可从已有只读种子缓存做 APFS clone；不使用用户正在运行的服务或硬件串口。

示例：

```sh
NODU_SIM_EVIDENCE_DIR=/absolute/new/evidence-dir \
NODU_SIM_SEED_HOME=/absolute/read-only/seed-home \
NODU_SIM_STUDIO_ROOT=/absolute/STM32_Study_Studio \
node desktop/scope-extension/test/arduino-simulation-package.cjs
```

证据目录必须新建，不能覆盖先前失败记录。测试在同一进程内创建 C3/S3 Nodu Arduino 工程、配置固定参数、捕获编译前依赖、实际调用服务编译、导出并发布包，再调用独立 Studio Python 消费者验证原始 bytes。负例覆盖源码修改、依赖内容修改、缺少分段、产物篡改、混入另一芯片 ELF、取消、撤销成功令牌、伪造快照及禁止覆盖已有包。结果分别保存在 `result.json`、真实服务命令日志、原始编译日志、manifest 与消费者日志；每个测试包保存包/ELF/Flash/content 摘要。

本轮初始解析失败记录保存在 `artifacts/esp-sim-export-20261027/` 及其 attempt 子目录。它们在真正编译前拒绝了官方索引的重复主机映射、旧 Darwin 主机名称和 CLI 库子目录布局；这些记录不是固件编译失败，也不算通过用例。最终实际通过状态以最新完成的 `result.json` 为准。类型检查使用 `tsc --noEmit`，不改已有构建文件。

作者实际运行 `attempt-04` 已完成 **23 PASS / 0 FAIL**，C3/S3 均为新的 Nodu 服务构建并由独立 Studio 消费者接受。`author-summary.json` 记录包、ELF、Flash、content 摘要与完整范围；`producer-used.ts` 与测试开始时记录的源文件 hash 一致。该测试载入模块之后又增加了不改变运行逻辑的 TS 类型标注，并将未充分核实的 CLI SPDX 结论收紧为 NOASSERTION；完整差异见 `producer-final.diff`，没有覆盖原包或原日志。最终源通过 `tsc --noEmit`。最终源的独立复跑应使用新的证据目录，不能把旧包的许可字段默认为已按最终代码更新。

## 服务集成边界

服务生命周期与菜单已经接线；`arduino-simulation-service.e2e.cjs` 是新的真实服务/连接验收入口，通过 `NODU_SIM_SERVICE_EVIDENCE_DIR` 和 `NODU_SIM_SEED_HOME` 显式启动。普通单测不会自动运行这两项真实编译集成测试。前端 26 项回归通过（含保存顺序、取消、配置错误可见性与切换工程）；完整 Arduino 回归为 88 PASS、2 个明确 SKIP、0 FAIL。两个 SKIP 是需私有目录和真实编译的 opt-in 集成测试，不冒充通过；它们另有以下实际运行证据。

现阶段原始包文件可持久保存并交给 Studio；没有将进程内成功 token 或 snapshot 冒充可跨重启身份。进程退出后重新导出需要真实重新编译。若以后要跨重启复用成功构建，必须持久保存并复核构建前完整输入证据，不能只把旧 token 文本读回来。Studio 导入与运行的生产接线由其自身实现负责。

`artifacts/esp-sim-export-20261027/service-author-01/result.json`：真实服务/RPC 验收 **17 PASS / 0 FAIL**，两芯片均先捕获输入再实际编译，使用成功 token 导出并经 Studio 独立消费者接受。负控覆盖源码与已安装库变化、缺失产物、混入另一芯片 ELF、连接内取消、连接断开以及新失败编译撤销旧成功 token。历史包字节在负控后保持不变。客户端额外提供的伪造 dependencies 字段未参与依赖发现。

`artifacts/esp-sim-export-20261027/integration-summary.json` 记录本轮服务/前端源码 SHA-256 与各日志路径。生成现有 `lib/` 已通过 TypeScript；这不意味着修改了用户正在运行的应用。

原生验收在单独复制的 Electron 应用及私有 Arduino home、项目、端口、用户配置中进行；每次启动记录独立 bundle 身份、参数和文件 hash。原生结果与辅助服务结果分别记录，不把 API 校验记为桌面交付通过。Windows/Linux 真实构建、跨应用原生点击交接及所有外设仿真不在本 Nodu 导出模块验收范围内。


## 本轮原生结果

`native-author-01` 在 C3 工程通过现有设备设置明确选择固定参数，再通过原生项目菜单和保存对话框实际编译导出；独立 Studio 消费者接受该包。首次检查发现极简布局收起输出时，配置拒绝原因不主动显示，保留为历史 **FAIL**，没有把整个首次桌面轮次记为通过。随后增加 `showExportOutput`，复用既有输出面板并校验工程身份；前端 26 项回归通过。

`native-author-02` 使用修复后新 bundle，S3 原生检查 **8 PASS / 0 FAIL**：配置拒绝立即可见且不改变原参数、明确选择固定参数、原生保存对话框触发真实编译与导出、成功提示、独立 Studio 校验、退出重开后界面保持预设、配置与 ZIP 摘要不变、仅本轮进程正常退出。S3 准备阶段显式隔离了 Arduino、embedded、resources、projects 和 Electron/Theia 配置；启动记录保留参数与 bundle hash。首轮 C3 的无关 embedded helper 沿用默认 data-dir，未执行任何 STM32 或硬件操作，相关限制在原始结果中保留。

两个原生菜单创建的包身份：

| 芯片 | 包 SHA-256 | ELF SHA-256 |
| --- | --- | --- |
| C3 | `37f33cf00b9551be4c7c38141208f228a89ce7b29736d869e4bc0b7546c03cf9` | `ccd3bf316aef08b4c170936d7856bed3b32c4166ad07190782cb256f44af23c3` |
| S3 | `251af9cf41b5726b98261a851e5c25e89a654350b5118533614c4676d9123471` | `b050e6721b56a4eb4501ac6d241c92d74a0c77b31c8c200eafa0bdeb197be73f` |

完整原始目录为 `artifacts/esp-sim-export-20261027/native-author-01` 和 `native-author-02`，其中包含包、私有工程/缓存、启动与退出重开日志和截图。小型可版本化证据归档位于 `docs/evidence/esp-sim-export-20261027/`，不重复复制工具缓存和完整固件包。C3 当前 bundle 的配置提示修复由共享实现测试和 S3 原生复测覆盖，未另冒称 C3 完整新一轮桌面重跑。
