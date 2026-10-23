# 新模板代码与 STM32F103 仿真验证

日期：2026-10-23。范围：验证公开新版模板的实际编译、两个引擎运行与搭芯桌面流程，核对外部固件导入能力。未连接实体串口，未烧录或复位实体板。本轮没有修改产品功能或发布新模板。

## 结论

| 能力 | 结果 |
| --- | --- |
| 用公开新模板创建工程、增加 C 模块、编译 | 通过，生成 ELF、HEX、BIN |
| 搭芯打开该工程，构建并运行 | QEMU、Renode 桌面均通过 |
| Nodu 编译的同一份 ELF 交给仿真引擎 | QEMU、Renode 均通过，使用内部适配器脚本 |
| 桌面选择外部 HEX/BIN/ELF 直接载入 | 尚未实现完整入口及服务流程 |
| 从搭芯导出构建产物 | 代码已有 ELF/BIN/HEX 导出选项，与导入能力不同 |
| Nodu 自动获取 Git 最新模板 | 仍为设计阶段；本次显式使用已验证的公开仓库克隆 |

验证芯片为 STM32F103C8T6，HSE 8 MHz、系统时钟 72 MHz。结果不外推到其他 STM32 芯片、外设或任意第三方固件。

## 测试工程与代码

工程：`artifacts/dacir-simulation-20261023/projects/f103-template-sim`。

来源：`https://github.com/libai1024/dacir-templates` 的 `v0.1.0`，提交 `3ccb83d143175c5085b87c6bb553b3fd669cea83`，模板 `dacir-temperature-humidity`。使用 Nodu 生成器的包路径参数，指向此前匿名 HTTPS 克隆并校验过的公开快照，不替换当前内置模板。

新增 `include/app_calibration.h` 与 `src/app_calibration.c`，实现温度加 2.0℃；`src/main.c` 调用新函数，OLED 标题改为 `DACIR v0.1.0`。未改接线。DHT11 DATA 为 PB1，OLED 为 PB6/PB7，虚拟串口 PA9→RX、PA10→TX。

Nodu 通过独立 native sidecar 构建，脚本 RPC 仅允许 trustProject、build、openProject，没有硬件操作。产物位于工程 `build/debug/firmware.{elf,hex,bin}`。构建脚本和输出分别为 `artifacts/dacir-simulation-20261023/build.cjs`、`nodu-build.json`。

## 实测证据

1. 内部引擎适配器对 Nodu 的同一份 ELF 运行 QEMU 与 Renode。两者在输入 24℃、55% 时输出 26℃、55%；实时改为 31℃、65% 后输出 33℃、65%。DHT 与 OLED 状态码均为 0；显示开启、帧缓冲非空，变更输入后帧缓冲确实改变。输入仅修改传感器环境属性，没有调整接线或伪造输出。
2. 在已启动的搭芯桌面创建独立测试会话，打开测试工程，点击构建、运行。QEMU 串口与 OLED 都显示 26℃、55%；通过画布上的 DHT11 交互面板改为 31℃、65% 后，两者显示 33℃、65%。
3. 停止 QEMU，选择 Renode 后运行；串口与 OLED 显示 26℃、55%。桌面运行按钮会重新构建，本次两次桌面构建的 ELF SHA256 相同。运行输入不写回初始环境，因此 Renode 新运行恢复到 24℃、55% 输入，这是预期行为。
4. 测试完成后停止所有本轮启动的仿真。测试工程保留，原有项目源码未修改，既有桌面服务未重启。

固件身份：

- Nodu ELF：`7dbeaa379eaec5d58ae35cc7a767fb4620e5c9ebae2fbe0b60105c3cc5fc847b`。内部双引擎使用这一完全相同的文件。
- 搭芯桌面 ELF：`fe341d7ebd0d6a20d0dae5430b418145b43aa9b68aef79495f16ce77a478ae70`。桌面双引擎使用内容完全相同的文件。
- 两套构建链生成的 ELF 摘要不同，不宣称跨构建链二进制一致。
- QEMU 桌面 buildId：`13f8c759157c498bb61be017bbe3e054`；runId：`ef2e19cbc56b4acc87c360cf39fd1379`。
- Renode 桌面 buildId：`2b66b147340645318aabd5f6bf1a7a2e`；runId：`fe5d9a7e503f42b699179525bde9ba15`。

完整机器证据：[2026-10-23-dacir-simulation.json](evidence/2026-10-23-dacir-simulation.json)。内部适配器脚本、原始快照及运行记录在 `artifacts/dacir-simulation-20261023/`。

桌面截图：

- [QEMU 初始输出](evidence/2026-10-23-desktop-qemu-baseline.png)
- [QEMU 实时输入与输出](evidence/2026-10-23-desktop-qemu-input.png)
- [Renode 输出](evidence/2026-10-23-desktop-renode-baseline.png)

界面自带“工程验收”没有作为本次通过判据。结束运行后其显示“测试中断”；本轮按新增校准逻辑验证真实串口和 OLED，没有运行或改写模板原有验收流程。

## 为什么不能称为已支持导入 HEX

搭芯源目录：`/Users/wangwei/Project/FC/STM32_Study_Studio`。

- `studio/service.py` 的 `simulation/run` 接受 buildId、engineId，从构建服务取记录，没有外部固件路径参数。
- `studio/simulation.py` 校验成功构建、当前源码摘要与产物摘要，加载 `build/<buildId>/firmware.elf`。
- 两个引擎的内部 `session.start(elf=...)` 可执行外部 ELF，本轮已经实测；这不等于产品有外部固件导入入口。
- `apps/studio-harness/packages/client/studio-workspace/src/client/Bottom.tsx` 中 ELF/BIN/HEX 是导出项。
- QEMU 内部把 ELF 转换为 flash.bin，也不能视为提供了任意 BIN 的导入流程。

要补齐此能力，建议在搭芯现有 MCU 属性或运行菜单增加“加载固件”，不增加 Nodu 顶级入口。先支持 ELF，再接入 HEX/BIN 的格式校验与地址映射；BIN 需要明确加载地址。外部固件应使用独立来源记录和 SHA256，不伪造构建成功记录，不绕过现有旧产物保护。运行仍使用当前电路接线与外设模型，不能根据固件猜测并自动改线。此处只记录后续建议，本轮未实现。

## 用户复测

1. 在搭芯“打开工程”中选择上述测试目录。
2. 选择 QEMU，点击运行，等待启动。OLED 标题应为 `DACIR v0.1.0`，温度 26.0℃、湿度 55.0%；串口 `temperature_tenths=260`、`humidity_tenths=550`。
3. 双击画布 DHT11，温度改为 31、湿度改为 65，等待新采样；OLED 应为 33.0℃、65.0%，串口为 330、650，两个状态码均为 0。
4. 点击停止，切换 Renode 后运行，初始值应恢复为 26.0℃、55.0%；可重复第三步。
5. 修改 `src/app_calibration.c` 中偏移值（单位 0.1℃），重新构建运行验证变化。实体板无需连接。
