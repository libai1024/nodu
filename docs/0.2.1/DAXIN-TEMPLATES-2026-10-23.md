# 搭芯模板接入与版本同步

日期：2026-10-23。当前范围：仅在 Nodu 现有“新建项目”窗口接入模板；两个应用保持独立。

## 已实现

STM32F103C8T6 的模板下拉增加：

- 搭芯温湿度 OLED
- 搭芯仓库温湿度监测
- 搭芯 ESP8266 联网

默认仍为“默认项目”，没有新增顶级入口、仿真面板、搭芯工具栏或运行状态同步。ESP8266 模板是 F103 控制外接模块，不是 ESP32 工程。切换到不兼容芯片后恢复默认模板。

新项目完整保留搭芯的 `src/`、`include/`、`drivers/`、`studio.project.json`、电路、布局和环境文件。源代码与接线原样复制，只有项目名称和 projectId 按新项目生成。项目仍可作为目录在搭芯打开；本轮未执行搭芯运行验收。

为保证从 Nodu 新建的项目能直接编译，增加了一个独立的 CMake 适配器，使用已有 Nodu Arm GCC 和 STM32 SDK，不启动搭芯或 Docker。它保留已核对的目录构建配方：freestanding runtime、HAL timebase、config header、驱动集合、64 KiB/20 KiB 链接布局、启动文件顺序。原始搭芯源码不改写；Nodu 支持文件放在 `nodu-support/`，不会进入搭芯原构建器的源码扫描目录。

生成项目使用现有 `stm32-hal` 外部 CMake 模式，而非旧设计稿中的新项目 kind/构建服务。实际工具链与搭芯容器工具链并不相同，本轮编译通过不表示产物逐字节相同或仿真行为已验收。固定时钟仍为 HSE 8 MHz / PLL 72 MHz，转实物前须核对实际条件。

`printf` 浮点选项在此模板中隐藏，因为其 freestanding runtime 不具备现有 newlib 开关语义。新建 C 模块仍遵循现有外部 CMake 项目的限制；可以在 `src/`、`include/` 添加文件，下次编译自动参与。

## 模板如何同步

采取“源项目维护 → 校验快照 → Nodu 发布”的方式，不在用户打开 Nodu 时自动读取开发者电脑上的搭芯目录，也不实时监听搭芯源码。

```text
搭芯发布模板
    ↓ 检查源清单、文件摘要、驱动版本与构建配方
同步到 Nodu 内置模板包
    ↓ 测试三套模板、构建 Nodu
用户更新 Nodu
    ↓
新建项目使用新版模板；已有项目保持原版本
```

本机开发维护命令，在 `desktop/` 下运行：

```sh
# 仅检查差异。无差异退出 0，有差异或校验失败退出非 0。
npm run templates:daxin:check -- --source /Users/wangwei/Project/FC/STM32_Study_Studio

# 更新 Nodu 的内置模板快照，不修改搭芯和用户项目。
npm run templates:daxin:sync -- --source /Users/wangwei/Project/FC/STM32_Study_Studio

# 编译适配与回归。
npm run compile --workspace @scope/studio-extension
DAXIN_SOURCE=/Users/wangwei/Project/FC/STM32_Study_Studio node --test scripts/daxin-templates.test.cjs scripts/project-generator.test.cjs
node --test scripts/daxin-templates-host.test.cjs
```

`--source` 可以换成其他搭芯仓库路径，或设置 `DAXIN_SOURCE`。运行中的产品不保存该开发路径。模板随 Nodu 的 `resources/daxin` 资源分发，已安装快照可离线新建。

同步时执行：

1. 核对三个模板的 `template-sources.json` 完整文件集合和 SHA-256，拒绝缺失、额外、被修改但未重新登记的文件及符号链接。
2. 核对模板的驱动提交与 `firmware/library/studio.lock.json` 一致，以及 F103C8T6、72 MHz、config header 配置。
3. 核对搭芯目录构建器与 `scripts/daxin/recipe-lock.json` 的已审查配方摘要。配方变化会阻止同步，需要先审查/更新 CMake 适配并重跑真实编译测试，不能直接忽略错误。
4. 将模板、支持文件、许可和适配器写到临时目录；全部成功后替换内置包。已有包保留到替换成功，失败恢复。
5. 生成内容寻址版本 `snapshot-<摘要前16位>`，记录来源 Git HEAD、驱动提交和构建器摘要。内容变化产生新版本，相同内容重复同步不会重复修改。
6. 创建项目时再次验证包与逐文件摘要，校验完成后才创建目标目录。拒绝覆盖同名目录，并发创建只允许一个成功。

源仓库的 Git HEAD 仅提供定位，真实输入以内容摘要为准；不能把未提交改动错误描述为某个提交的原样内容。增加第四个模板或改变芯片支持范围时需要明确更新目录和验收，不自动把所有新目录暴露给用户。

## 已有工程如何升级

**已有项目不会自动升级。** 每个创建出的项目保存：

- `template-origin.json`：模板 ID、包版本、来源提交、驱动提交和创建时文件摘要。
- `nodu.lock.json`：Nodu 模板锁与搭芯包摘要。
- 完整独立的源码副本，不通过符号链接共享内置模板。

因此 Nodu 更新或再次同步模板不会覆盖用户修改，也不会偷偷更换驱动、接线和环境。

目前需要升级某个旧项目时：先提交或备份旧项目，再用新模板创建另一个目录，比较并有选择地迁入更新；验证通过后保留新锁和变更记录。不要直接把新版 `drivers/`、`circuit.json` 整目录覆盖旧项目。

后续如果需要“一键升级现有项目”，应实现三方比较（旧模板基线、当前用户文件、新模板）：未修改文件可更新、双方修改则展示冲突、删除文件单独确认、代码与接线分别审查。当前只保存了基线摘要，实施三方合并还必须获取并验证旧版模板的完整内容；本轮没有实现自动合并，也没有增加升级按钮。

## 本轮验证

| 项目 | 结果 |
| --- | --- |
| TypeScript 编译 | 通过 |
| 模板创建/原有芯片生成器测试 | 9/9 通过 |
| 真实 Nodu 编译测试 | 三套搭芯模板全部通过；测试报告含父测试共 4/4 |
| ELF/BIN/HEX/MAP、compile_commands.json | 三套模板均非空，BIN 在 F103C8 容量内 |
| 修改源码后产物过期 | 三套模板均正确标记 |
| 上游升级 | 新项目获得新版，旧项目用户修改与版本锁均未变化 |
| 无效上游升级 | 源摘要错误、构建规则变化均拒绝，旧模板包保留 |
| 界面 | 现有窗口中选模板、切芯片清除不兼容项、Tab/Enter 创建，创建后原编译按钮成功 |
| 浏览器与 Electron 构建 | 均通过；未把构建成功视为桌面运行验收 |
| 许可扫描、差异空白检查 | 通过；原始许可证与第三方清单已保留 |
| 仿真、实物烧录/复位、物理串口连接 | 本轮未执行，不作为模板接入的通过项 |

界面测试使用独立服务 4216 和 `artifacts/daxin-templates-20261023`，没有替换用户 4215 工作区或搭芯服务。界面记录为浏览器辅助验证，不冒充独立桌面安装包验收。正在运行的旧实例需重启后加载新的后端代码；独立验证实例已使用新代码。

证据：

- [模板与升级测试](evidence/2026-10-23-daxin-templates.tap)
- [真实编译测试](evidence/2026-10-23-daxin-builds.tap)
- [同步检查](evidence/2026-10-23-daxin-sync.json)
- [现有新建窗口截图](evidence/2026-10-23-daxin-template-ui.png)

手动复验：重启 Nodu → 新建项目 → STM32F103 → 搭芯温湿度 OLED → 创建 → 编译；确认目录含源码与 `circuit.json`，编译成功。再打开新建窗口切到 F407/ESP32，确认不出现搭芯模板。测试已有项目保护时，修改旧项目的 `src/main.c`，执行上述同步命令，确认该文件与 `template-origin.json` 均不变。
