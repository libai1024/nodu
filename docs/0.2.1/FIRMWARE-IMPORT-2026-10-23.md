# Nodu 产物目录与 DACIR 外部固件导入

日期：2026-10-23。范围：打开编译产物目录、导入外部 HEX/BIN、向指定 STM32 模型拖拽固件。未烧录、复位或连接实体板。

## 已实现

### Nodu

- 运行下拉菜单增加“打开产物目录”，编译输出面板增加文件夹图标按钮。
- 按当前工程 `nodu.json` 的 debug/release 配置定位 `build/<preset>`；至少存在 `firmware.bin` 或 `firmware.hex` 才打开。
- 未编译时提示“尚无 BIN/HEX 产物，请先编译。”；不触发编译、下载或创建目录。
- 使用独立参数调用系统目录打开器，支持中文、空格路径。本轮实际验证 macOS Finder；Windows/Linux 分支未实机测试。

### DACIR

- 现有“运行”下拉菜单新增“加载固件”，紧凑弹窗选择目标芯片和 HEX/BIN，不新增顶级入口。
- 选择“加载并运行”直接执行导入固件，不构建工程源码。正常“运行工程”仍走原有构建流程。
- 向 STM32 模型拖入一个 HEX/BIN 时，通过当前相机的射线命中识别实际实例 ID，传递明确 `targetId`；不依据选中对象，也不使用列表第一项作为默认目标。
- 拖拽悬停显示“加载到 <实例 ID>”；空白区域、其他器件、多文件及运行中导入均拒绝。
- 导入文件、转换后的 ELF 和元数据保存于工程 `.studio/firmware/<导入ID>/`；元数据绑定工程 ID、目标实例 ID、芯片、原始文件及规范化固件摘要。
- 运行记录保存外部固件身份。不会伪造成功构建记录，复用错误目标的固件 ID 会拒绝。
- HEX 检查记录格式、校验和、EOF、重叠、地址范围和向量；BIN 检查大小、初始栈和复位入口。两者统一封装为 ARM ELF，Flash 字节不改写。
- 弹窗支持键盘选择和提交、Esc/关闭/取消；关闭后焦点回到“运行选项”。布局已改为随内容收缩，文件选择按钮使用现有主题变量。

## 当前支持边界

- 当前仿真模型为 STM32F103C8T6，64 KB Flash、20 KB SRAM，完整固件从 `0x08000000` 启动。暂不支持偏移 Bootloader 应用、其他芯片、外部 ELF 导入。
- HEX 文本最大 1 MB，解析后 Flash 镜像最大 64 KB；BIN 最大 64 KB。
- 引擎仍只支持单 STM32 运行。多实例导入记录可明确绑定目标，但界面导入并运行时，多 STM32 工程会返回“不支持多 STM32 运行”，不会悄悄加载到第一颗芯片。
- 多 STM32 同时执行、独立复位/时钟、485 总线收发和调度属于后续引擎功能；本轮未宣称完成。
- 现有工程验收面板不等同于外部固件行为验收；停止测试后可能显示“测试中断”。本报告依据真实引擎输出和运行记录判定。
- Nodu 的 Git 自动同步消费端仍是此前设计状态，本轮没有改变。

## 测试结果

| 项目 | 结果 |
| --- | --- |
| Nodu 扩展 TypeScript 编译、浏览器生产构建 | 通过 |
| 产物路径测试（缺失、debug/release、中文空格、非 STM32） | 通过 |
| Nodu 菜单与输出按钮打开 Finder | 两个入口均通过，目录含 firmware.bin/hex |
| DACIR 后端导入、现有服务、运行限额回归 | 64 项通过 |
| Web TypeScript、桌面工作区 TypeScript 和 bundle | 通过 |
| 多实例 Three.js 射线命中 | mcuA/mcuB、列表倒序、其他器件、空白、已删除目标通过 |
| 实际 FirmwareDrop 事件处理单测 | targetId/File 传递、导航阻止、多文件、忙碌、监听器卸载通过 |
| 外部 BIN → QEMU / Renode | 两组真实引擎运行通过 |
| 外部 HEX → QEMU / Renode | 两组真实引擎运行通过 |
| 原生桌面文件选择器导入 HEX/BIN | 两种均成功运行 QEMU，未触发构建 |
| 原生桌面键盘提交、Esc 焦点恢复、小窗口布局 | 通过，截图为 1514×1200 物理像素窗口 |
| Finder 跨窗口真实文件拖拽到模型 | 尚未完成原生端到端操作；事件与目标命中已自动化验证，需人工复测 |
| 实体板、Windows/Linux 桌面、多个 MCU/485 联合仿真 | 未测试或未实现，不属于本轮通过项 |

真实引擎使用公开 v0.1.0 模板创建并修改过的 Nodu `f103-template-sim` 工程：新增温度校准 C 模块，24℃输入输出26℃、31℃输入输出33℃，湿度55%→65%，OLED 帧同步变化，DHT/OLED 状态均为0。四组运行没有任何 BuildService 构建任务。

BIN 为 20348 字节。原始 BIN SHA-256：`0501f788f8ce376edbeaa71a560fdd734c16ab6875df072608349b7838d1b65e`。
四组规范化 ELF 相同：`4f66793f8555af141d6df613ab08dcbd75639a1751bbaa89f8fb05c6ee377a2a`。
原生桌面 HEX runId：`f2095840d32a43a3b78e79c4abf5d67e`；BIN runId：`fffcbf0901d14a3c8ea865b02e976f46`。后者 `build.status=idle`、`buildId=""`、`targetId=mcu`。测试仿真已停止。

## 用户复测流程

1. 在新 Nodu 测试页面打开 `f103-template-sim`，从运行下拉菜单选择“打开产物目录”，或点击编译输出右侧文件夹按钮。应打开包含 BIN/HEX 的 Finder 窗口。
2. 打开本轮独立的 `DACIR Firmware Test.app`，已有独立测试工程与接线。保持仿真停止，将 Finder 中 `firmware.bin` 拖到蓝色 STM32 模型本体。悬停应显示目标 ID `mcu`，释放后运行并显示 `firmware.bin → mcu`。串口应有 temperature_tenths=260、humidity_tenths=550，OLED 显示26℃/55%。
3. 停止后拖入 HEX，结果应相同。也可使用“运行选项 → 加载固件”，明确选择目标芯片和文件。
4. 将文件拖到空白、DHT、OLED，或同时拖两个文件：不得启动仿真。运行中再拖文件：不得替换正在执行的固件。
5. 在独立测试工程中放置第二颗 STM32，用不同实例 ID 检查悬停目标；不得把第二颗的文件加载到第一颗。当前启动应明确报告多 MCU 不支持；完成后撤销第二颗。
6. 用 Esc、关闭按钮和取消退出弹窗，焦点应返回运行选项；Tab 可到达目标选择、文件和提交按钮。

## 交付与记录

原用户的 DACIR 服务和项目保持运行状态未重启。测试采用独立 API `23981`、renderer `23982`、Nodu `23916`，独立账号资料目录和工程副本。源代码和开发 bundle 已更新，尚未制作新的正式安装包。

测试版路径：`/Users/wangwei/Project/FC/STM32_Study_Studio/artifacts/firmware-import-20261023/DACIR Firmware Test.app`。
测试固件目录：`/Users/wangwei/Model/k210-studio/artifacts/dacir-simulation-20261023/projects/f103-template-sim/build/debug`。

后端与真实引擎证据：DACIR `artifacts/firmware-import-20261023/`（real-results.json、各格式/引擎状态、desktop-bin-state.json、截图和测试日志）。Nodu `docs/0.2.1/evidence/2026-10-23-external-*` 保存简要证据。

主要实现文件：Nodu `nodu-build-location.ts`、embedded command/server/panel；DACIR `studio/firmware_import.py`、`studio/service.py`、`studio/simulation.py`、`web/studio/FirmwareDrop.tsx`、`firmwareDropTarget.ts`、`Renderer.tsx`；嵌套桌面源 `FirmwareDialog.tsx`、`views.tsx`、`locales.ts`、`ProjectDialog.module.css`。

DACIR 嵌套桌面源码已同步到父仓库的 `apps/studio-integration/integrated-source.patch` 与 `SOURCE-SNAPSHOT.json`，临时 Git index 生成，反向应用检查通过；没有写入账号资料或生成物。未提交或推送本轮产品代码。
