# Nodu 0.2.4

本版修复智慧教室完整程序在 Windows/Keil 验证中暴露的工程兼容问题，并补齐项目打开、最近项目和未知芯片选择流程。

## 共用源码约定

原生 HAL 工程支持 STM32F103C8T6、STM32F407ZGT6，以及 F103 HAL 72MHz 适配。GCC、Arm Compiler 5、Arm Compiler 6 引用同一份业务源码。新工程以 C99 编译；Keil 生成前检查非通用头文件、C11 写法及不能等价映射的编译选项。

- 使用 `<string.h>`，避免依赖 GCC/newlib 提供的 `<memory.h>`。
- 用有明确名称的 `typedef char Guard[(condition) ? 1 : -1]` 保留跨编译器的编译期检查，不能删除或弱化检查。
- SDK 必须包含 CMSIS 的 ArmCC、ArmClang 和对应 Cortex 内核头文件；缺失时阻止生成并说明文件名。
- 业务源码不自动改写。错误列出文件、行列、原因和改法，同时进入 Nodu 的“问题”面板。
- GCC 的 `-fstack-usage` 仅影响诊断输出，Keil 不生成 GCC `.su` 文件；这项差异记录于 `MDK-ARM/compatibility.json`。

“1:1”指源码、每文件的宏/头文件查找顺序、数据 ABI、应用 Flash 边界、RAM 段、堆栈和持久化约定保持一致，不要求不同编译器生成相同机器码或相同格式的诊断文件。外部构建、搭芯 SPL 目录适配、额外 GNU 汇编/库和未适配链接语义会明确拒绝，不能静默丢弃。

## 编译与 Keil 一致性

受支持 STM32 工程的正常编译流程固定为：配置并使旧产物失效 → 生成/更新 Keil 工程并执行共用源码检查 → 本机存在 Keil 时后台实编已安装的 AC5/AC6 → GCC 构建。该流程不受编辑后的自动维护开关控制。

无 Keil 的 Mac/Windows 仍允许本地构建和烧写，但结果仅标记兼容检查通过，不能显示成 Keil 已实编。Keil 已安装但编译器、许可或源码有错误时阻止本次构建，输出原始日志和源码诊断。后台使用 `UV4 -r … -j0`，不执行烧写、复位或调试命令。

兼容检查开始前使旧产物失效；验证的输入摘要会传入 GCC 并在锁内比较。HAL72 联动同时验证原工程与快照输入，检查失败不保留旧的可下载快照。停止操作、跨窗口互斥和失败后的恢复有独立回归测试。

## Keil 转换与维护

从实际编译数据库读取源文件及每文件配置，从实际 Ninja 链接参数或项目链接配置读取 GNU 脚本。转换应用区、配置保留空间、RAM 向量表、`.RamFunc`、堆和 RAM 顶部栈；向量长度检查转换为 `ScatterAssert`。F407 同时保留硬浮点 ABI 和未使用 CCM 的信息。

更新时保留 Keil 调试设置、用户分组、文件启用状态和自定义启动/scatter。自定义 Flash 范围或堆栈与 GNU 配置不一致时停止更新。XML 合并保持 µVision 要求的字段结构和顺序；回归同时覆盖首次生成和增删文件后的真实编译。

SDK、授权、启动和 Arm 运行库文件随 MDK-ARM 提供；工程不引用原电脑的工具包路径。ST-LINK 默认驱动为 `STLink\ST-LINKIII-KEIL_SWO.dll`，下载采用按扇区擦除，保留应用区外的用户配置页。

## 项目打开

文件菜单和项目菜单增加“打开项目…”及“最近项目”。支持选择文件夹、nodu.json、Keil 工程文件；选择上层目录时寻找真正的项目根目录，找到多个项目时让用户选择。最近项目中的缺失目录保留为不可用条目。

芯片目录直接读取本地资源，不依赖连接设备或共同服务。首次并发调用会等待完整握手，失败连接会清理，业务操作不自动重试。

无法确定芯片时显示“选择芯片”，不按 K210 处理。用户明确选择受支持型号后写入 nodu.json，已有配置先备份。只有源码、没有 CMake 构建配置的目录标为 sourceOnly，允许查看和编辑，禁止编译/烧写；不会猜测或覆盖引脚初始化。

## 验证入口

```sh
cd desktop
npm run compile --workspace @scope/studio-extension
node --test scope-extension/test/keil-*.cjs scope-extension/test/project-*.cjs
node --test scope-extension/test/*.cjs scripts/*.test.cjs
cd native
cargo test -p nodu-embedded --lib
```

实机编译矩阵包含完整智慧教室、原有 Keil 工程升级和增删文件同步、F103、F407；每项检查 AC5/AC6 的真实 Rebuild 日志。发布产物与运行验证记录单独保存在本次构建目录，不把客户联网配置或整片 Flash 备份加入 Nodu 源码。
