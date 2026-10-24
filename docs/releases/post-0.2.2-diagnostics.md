# 系统错误通知与日志（2026-10-24）

基线：`595f69b`，分支：`codex/nodu-02-integration`。本次为 0.2.2 发布后的源码修复，未重新打包、上传或移动发布标签。

## 问题与行为

编辑器服务启动异常原先写入 STM32 任务状态栏，点击却打开构建输出；极简模式还隐藏了通知中心入口。因此完整异常既占用错误的位置，又难以追查。

参考 [VS Code Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications)，复用现有 Theia 通知与 Output，未添加新的弹窗框架：

- 编辑器服务、工程加载、STM32 工具包和后台服务错误给出右下角短通知。通知支持“查看日志”，可安全重试的操作提供“重试”；用户可按来源选择“本次不再提醒”。
- 详情写入底部“输出 → Nodu 日志”，包含时间、来源、异常堆栈、错误码及工程/阶段上下文。日志可选择复制，不在错误发生时自动抢占面板。
- 极简与专业模式均可通过右下角铃铛查看通知；命令面板提供“Nodu: 显示日志”和“Nodu: 重新启动编辑器服务”。
- 构建、下载进度仍属于开发面板。空闲服务错误不覆盖上一次构建状态；服务中断正在执行的任务时，任务状态明确显示“任务已中断”。
- 同一会话错误去重但继续记日志；切换工程使旧重试失效，重新进入工程允许新通知；服务真实恢复后下一次故障可再次提示。

日志属于当前窗口 Output 历史，受既有容量限制；本次未实现跨应用重启保存或远程上传。

## 编辑器启动原因与修复

当前源码预览进程确实没有传入 `--plugins=local-dir:<desktop/plugins>`，导致 clangd 命令不存在。正常 `desktop/scripts/launch.cjs` 已有该参数，不能据此认定已发布安装包缺少插件。本次已补齐当前预览启动参数。

代码同时修复启动/重连竞态：等待可执行的命令桥接后触发正常插件激活，最长等待 30 秒；只对执行前的 `NO_ACTIVE_HANDLER` 自动重试。实际执行失败不会自动重复执行。工程切换和窗口关闭以 generation 隔离迟到结果；启动、停止顺序串行处理。

后台服务恢复信号由本次子进程的首个有效关联 RPC 响应触发，业务拒绝同样能证明服务已响应；仅创建进程、日志输出和主动事件不能表示就绪。旧进程迟到输出不改变新状态。恢复信号用于重置故障通知，不能清空同次下载的运行证据；进程退出仍会清除旧证据。

## 验证与证据

扩展 TypeScript 编译通过。以下单次组合回归 **74/74** 通过，无跳过：

```sh
cd desktop
npm run compile --workspace @scope/studio-extension
node --test scope-extension/test/system-diagnostics.cjs \
  scope-extension/test/clangd-client.cjs \
  scope-extension/test/embedded-server-lifecycle.cjs \
  scope-extension/test/tutor-runtime-evidence.cjs \
  scripts/clangd-adapter.test.cjs \
  scope-extension/test/compact-device.cjs \
  scope-extension/test/minimal-workbench.cjs \
  scope-extension/test/problems.cjs \
  scope-extension/test/workbench-layout.cjs
```

覆盖同工程重进后的重试、重复通知、异步失败、命令未注册/延迟注册、工程切换、窗口关闭，以及真实 Node stream/readline 上的服务退出/重启/旧回包隔离。后台子进程和 flash 响应由测试替身模拟，未操作硬件。

`theia build --mode development` 的 browser、node、electron 三部分均零错误；`git diff --check` 通过。

实际 macOS Electron 源码预览，使用本任务隔离 profile 和 `release-final-f103` 测试工程：

| 场景 | 实测结果 | 截图 |
| --- | --- | --- |
| 缺插件启动，专业模式深色 | 右下角简短通知，无顶部长异常 | `notification-dark.png` |
| 极简模式浅色 | 通知与铃铛均可访问 | `notification-simple-light.png` |
| 点击重试 | 重新尝试启动，失败不叠加重复通知 | 同上 |
| 通知中心点击查看日志 | 打开底部 Nodu 日志，可见错误码、堆栈与工程上下文 | `system-output-simple-light.png` |
| 补齐插件目录后正常重启 | 日志确认 C/C++ 服务启动，插件宿主和真实 clangd 进程存在 | `service-recovered.png` |
| `main.c` 中 `HAL_Init` 按 F12 | 跳至 SDK `stm32f1xx_hal.h:282` 的声明 | `clangd-navigation.png` |

截图、测试日志和预览启动日志保存在执行机器 `~/.codex/nodu-diagnostics-20261024/`。未修改测试工程源码，未调用 AI 模型、烧写或连接硬件。界面中已有的编译成功结果不计为本次新增验证。

最终构建后一次启动因会话中断遗留的本任务后台进程占用 24368 失败，保留 `final-preview.log`。核对工程路径/profile/PID 后仅向该孤立后台进程发送 TERM，端口释放后再次启动成功，见 `final-preview-2.log`。最终桌面复核为工程已打开、通知为空、语言插件 active；用户开始操作窗口后停止继续点击。

预览启动日志仍有既有 plugin-host `punycode` 弃用警告和 Output 焦点警告；未宣称所有日志均无警告。Windows 未做桌面验收。
