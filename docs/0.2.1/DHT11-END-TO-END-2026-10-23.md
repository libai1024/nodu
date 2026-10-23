# STM32F103C8T6 温湿度与串口端到端验证

日期：2026-10-23。范围：Nodu 创建/编辑/编译 → DACIR 指定 MCU 外部 HEX 导入 → QEMU/Renode 仿真。未连接、下载或复位实体板。

## 工程与接线

工程：`artifacts/dacir-simulation-20261023/projects/f103-dht11-uart`，ID `25e8010b-73f6-4e14-a14c-5eb949c37bb4`。

先通过 Nodu 的新建项目界面选择 STM32F103C8T6、搭芯温湿度 OLED 模板，再删去本次不用的 OLED。使用当前内置模板快照，不是远程 Git 自动同步后的公开 v0.1.0 模板；Git 同步消费端仍未实现。

在编写本次程序前，使用搭芯现有 Studio 命令 API 建立实际连接，并在原生 DACIR 桌面核对模型和接线。不是用界面坐标假装手工接线。前后快照分别为 `00-unwired.json`、`01-wired-before-code.json`。

| STM32 | 外设 |
|---|---|
| 3V3 | DHT11 VCC |
| GND | DHT11 GND |
| PB0 | DHT11 DATA |
| PA9 / USART1 TX | 串口 RX |
| PA10 / USART1 RX | 串口 TX |
| GND | 串口 GND |

串口为 115200、8N1。工程只保留一个 MCU、一个 DHT11 和一个串口模型。故障测试后六根线已恢复，环境默认 24℃、55%RH，测试仿真已停止。

## 实际程序与导入

通过 Nodu 编辑器打开 `src/main.c`、输入程序并保存，再使用界面“编译”。程序每约 2 秒读取一次 DHT11，打印序号、运行时间、温度和湿度。读取失败只打印错误码，不显示伪造或上次成功值。串口收到 `?` 后回复 `ACK NODU_DHT11 v1`。

初版使用 snprintf，但模板以 `-nostdlib` 链接，因缺少 libc 符号失败；改为小型整数格式化函数和已有 UART 驱动，未增加浮点 printf 依赖。最终生成 BIN 5940 字节、HEX 16780 字节。

在 DACIR 原生桌面通过运行选项“加载固件”，明确选择 `mcu`，使用系统文件选择器导入 `build/debug/firmware.hex` 并运行。搭芯没有执行源码编译，`buildId` 为空；运行的是 Nodu 产物经导入器生成的 ELF 包装。

| 产物 | SHA-256 |
|---|---|
| main.c | `80ce9a8f3096dd717f006bb15ca291830bd3fb49f374591b89434a9c123ab2a2` |
| HEX | `6da6f30ab69863b29b05a5ba6981888114eaf8c95743c1f451f051e3cd0503e7` |
| BIN / Flash 内容 | `28844e2f1db5e55369362a84a2e0c2778dc4ffe159ec711b2705b249e4849bef` |
| Nodu 原始 ELF | `27d0bcb3c5a73859d348b769de39825b8aafd82085c9dc7b2288fbee319ba084` |
| 双引擎实际执行的导入 ELF | `29c5fd5fcf62943c2674c22d42e4d8fb5ac5025d3e19d7e14ad4729c602d3427` |

固件导入 ID：`eaea703f80e345959d076301d18fe374`。双引擎使用同一导入固件，未为不同引擎生成不同测试程序。

## 验证结果

| 测试 | QEMU | Renode |
|---|---|---|
| 启动与 24.0℃ / 55.0%RH 输出 | 通过 | 通过 |
| 运行中改为 31℃ / 68%RH，输出随之变化 | 通过 | 通过 |
| 发送 ?，收到 ACK | 通过 | 通过 |
| 断开 PB0→DATA，报告 DHT11_ERROR=1，无成功读数 | 通过 | 通过 |
| 恢复接线后读取恢复 | 已恢复最终电路 | 通过 |

QEMU 的导入、温湿度修改和串口发送均通过原生桌面操作。Renode 正向与两引擎断线用例使用现有 Studio API 驱动真实引擎；原生桌面再次确认恢复后 Renode 输出。运行输入经过电路模型和 GPIO/UART 连接，未向串口日志直接注入读数。

QEMU 首两次采样时间为 1034ms、3041ms；Renode 为 1022ms、3023ms，符合约 2 秒采样。示例输出：

```text
NODU_DHT11 v1 MCU=STM32F103C8T6 DATA=PB0 UART=115200,8N1
sample=1 uptime_ms=1034 temperature=24.0 C humidity=55.0%RH status=OK
ACK NODU_DHT11 v1
sample=17 uptime_ms=33147 temperature=31.0 C humidity=68.0%RH status=OK
```

运行 ID、完整原始输出、状态快照和截图位于 `artifacts/dht11-e2e-20261023/`；以 JSON 原始记录为准。

## 本次发现并处理的问题

1. 独立测试 Nodu 服务仍加载旧版 staged native 程序，外部模板被错误当作 CMake Presets 工程。重新构建并按项目脚本打包 native，只重启本次 23916 测试服务。
2. GCC 专用诊断参数被 clangd 误认为编译错误。搭芯项目生成器增加 `.clangd`，仅移除 `-fdiagnostics-plain-output` 和 `-fdiagnostics-column-unit=*`；现有测试工程同步补齐。Nodu 实际编辑器确认红色诊断消失。TypeScript 编译通过，模板测试 4 通过、2 跳过（需外部升级夹具），0 失败。
3. 同目录搭芯仿真生成 `runs/`、`.studio/` 记录，曾导致 Nodu 在无 C 源码修改时判定编译过期。仅对 `dacir-directory-v1` 适配工程将这两个根目录排除出构建输入摘要；普通工程不变，源码、头文件和嵌套同名源目录仍被追踪。回归测试覆盖运行记录变化不失效、源码修改会失效。Rust 库测试 41 通过、0 失败。更新 native 打包并重启独立服务后，Renode 正在输出串口时再次通过 Nodu UI 编译，成功生成 current-build 标记（`b-20261023-043733-cfaa4d`），没有过期误报；结束后停止仿真。

首次失败和修复过程均保留，不将首次运行描述为一次通过。重复编译的 HEX/BIN 摘要与已仿真固件相同。

## 用户复测

1. 在 Nodu 打开上述工程，查看 `src/main.c`，点击“编译”。本次只需要编译，不点实体板“运行/下载”。
2. 从运行下拉菜单打开产物目录，找到 `build/debug/firmware.hex`。
3. 在搭芯打开同一工程，确认六根线。运行选项 → 加载固件 → 目标 `mcu` → 选择该 HEX → 加载并运行。
4. 串口每约 2 秒输出 24.0℃、55.0%RH；双击 DHT11 模型，将温度改为 31、湿度改为 68，观察后续读数。
5. 串口输入 `?` 并发送，应收到 ACK。停止后可切换另一引擎，用相同 HEX 重复。

这次验证的是仿真链路，不代表实物 DHT11 电气时序、长时间稳定性或多 MCU/485 已通过。主界面的通用“工程验收”在手动停止时显示“测试中断”，它不是本次专用用例的判定结果；本次结果来自实际输出断言和保存的状态记录。

后续跨应用 MCP/CLI 应固定传递工程 ID、目标 MCU 实例 ID、固件路径及摘要，并先导入校验、再显式运行；多 MCU 场景不能默认选择第一个模型。本次未新增跨应用入口或实现该接口。
