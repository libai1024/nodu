# Nodu 与 Keil 5 共用工程

0.2.4 支持原生 **STM32F103C8T6 / STM32F407ZGT6** HAL 工程及 F103 HAL 72MHz 适配；支持每文件独立的宏和头文件路径。外部 CMake、搭芯 SPL 目录适配、额外 GNU 汇编/C++ 或库需先适配，不能丢弃后继续生成。业务源码采用 GCC、AC5、AC6 共用的 C99 写法，详见 [0.2.4 约定](0.2.4/README.md)。

## 使用

- 在文件菜单选择 **Keil 工程 → 生成 Keil 工程**。生成后同一位置变为 **更新 Keil 工程**。
- 在项目的 **工程设置** 中可开启 **自动维护 Keil 工程**，默认关闭，保存于当前项目的 `nodu.json`。
- 自动维护在 Nodu 打开该项目期间生效，新增、删除、重命名源码或修改 CMake/HAL 配置后更新；正在编译或有未保存修改时等待。
- Windows 检测到已安装的 Keil 后显示 **在 Keil 中打开**，先保存并更新工程，再启动 µVision。Mac 可以生成、更新并交付工程给 Windows。
- 文件和项目菜单均提供 **打开项目… / 最近项目**；未知芯片由用户手动选择。

生成的入口为 `MDK-ARM/Nodu.uvprojx`，包含 `Nodu AC6` 和 `Nodu AC5` 两个目标。选择本机已安装并授权的 Arm Compiler 6 或 5。Keil 和 Nodu 引用同一套 `Core`、`Board`、`App` 源码，无需复制编辑内容。

HAL/CMSIS 和编译器专用启动、串口运行库文件由本地工具包提供，生成过程不下载文件。Keil 本身、编译器许可和匹配的 STM32F1xx DFP 由用户现有 Keil 环境提供，本功能不安装 Keil。初始下载配置为 ST-LINK/SWD；其他探针可在 Keil 中自行配置。智慧教室完整工程已通过 AC5/AC6 编译；AC6 固件通过此前实板下载、读回及云端上传验证。0.2.4 转换后的 AC6 程序与该实板版本逐字节一致。

## 更新边界

Nodu 维护自身文件分组、宏、包含路径、优化级别和芯片配置，并使用实际 CMake 编译数据库作为来源。Keil 调试设置、用户自建分组、已有文件的单独配置和 `.uvoptx` 保留。手动修改 Nodu 管理的编译设置或支持文件时，更新停止并提示冲突，不自动覆盖。

`MDK-ARM/.nodu-keil.json` 是维护基线，应随工程保留。已有其他内容的 `MDK-ARM` 目录不会被接管。首次生成不更改 GCC 启动文件或 newlib 的 `syscalls.c`；Keil 输出不使 Nodu 的 GCC 构建变为过期。

转换依据实际 GNU 应用区、RAM 段、堆栈和配置保留区。自定义 Keil scatter/启动参数若与 GNU 配置不一致，会停止并要求合并。

发生冲突时，在 Keil 中核对配置：自定义源码放入自建分组；需要两边共用的宏、头文件路径和文件列表在 Nodu 工程配置中维护。修正冲突后从文件菜单手动更新。

## 维护与验证

生成器：`desktop/scope-extension/src/node/nodu-keil-project.ts`。官方 ST 启动文件、许可和固定来源哈希在 `desktop/scope-extension/resources/stm32/keil/`，随已有 STM32 resources 打包。

```sh
cd desktop
npm run compile --workspace @scope/studio-extension
node --test scope-extension/test/keil-project.cjs scope-extension/test/keil-maintenance.cjs
node --test scripts/stm32-keil.test.cjs
cd native
cargo test -p nodu-embedded --lib
```

真实主机测试需要本地 STM32 工具包和已编译的 native sidecar；缺失时明确跳过。测试通过环境变量 `NODU_STM32_TOOLKIT`、`NODU_EMBEDDED_BIN` 指向目标平台资源。

实测记录见 [Keil 集成验证](evidence/keil-integration-20261028.md)。
