# STM32F103 教学链路验证

2026-10-24：使用 Nodu 生成默认 STM32F103C8T6 C 工程，真实 GLM Coding Plan 生成两步串口教学，再以脚本模拟编辑器输入虚影，完成静态审阅、构建、ST-LINK 下载、运行与串口观察。**不是 Electron 人工跟写验收。**

`projects/f103-tutor` 保留可编译结果，USART1 使用 PA9/PA10、115200 8N1，每秒输出 `NODU_TUTOR_F103_20261024`，不依赖开发板 LED 或传感器。HAL/CMSIS 启动与系统文件保留原许可，SDK 使用项目锁定的 STM32CubeF1 1.8.7。

- `f103-goal-probe.cjs`：手动模型探针，从关闭回显的 PTY 标准输入接收本次明确提供的凭据；不读历史密钥。它会修改测试工程 main.c，应先恢复同目录 `main-before-tutor.txt`（本机保留，不提交）或重新创建默认工程，不能在已完成代码上重复运行。
- `f103-build-boundaries.cjs`：手动源码过期/语法错误/旧产物拒绝验证，finally 恢复源码并重建；检查未出现 flash.started。
- `f103-hardware.cjs`：**会写入板子**。仅限本次已识别的 UID、USB 下载器位置和串口；每次用独立数据目录先备份完整 Flash，不能当作通用自动测试执行。源码中保留本机工具包路径，换机器先显式配置工具包，不自动选择其他板子。

证据在 `docs/ai-tutor/evidence/nightly-20261024-f103-*`。第一次模型探针将循环代码放错位置，模型准确拒绝；脚本定位改为匹配独立 while 行。同时修正提示中的字符串长度策略，使用 sizeof(msg)-1。随后生成代码未经人工修改即编译、读回校验、运行成功；下载后捕获 5 行新串口数据。

本次烧录前固件备份位于硬件报告的 dataDir 下 `stm32/backups/<backup.id>/flash.bin`，完整 65536 字节，摘要保存在报告中。备份在 Git 外，没有覆盖此前备份。F407 未烧录。
