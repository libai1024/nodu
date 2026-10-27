# UI 对照重启保护记录

日期：2026-10-25。

用户要求先重启 Nodu，再与 Cursor 做 UI 对照。

原窗口：Nodu Review，release-final-f103，main.c 有未保存编辑，main.h 打开。
当前教学对话草稿原文：

```text
要放前看
```

原配置目录：/Users/wangwei/.codex/nodu-release-0.2.2/launcher-reconcile-profile/electron
原工程：/Users/wangwei/.codex/nodu-release-0.2.2/projects/release-final-f103
前端构建：2026-10-25 12:25:40；最新源码提交 ba63cd6。

## 实际执行结果

1. 先执行了 Nodu 的“重新加载窗口”。重载前出现保存提示，列出两个名为 main.c 的未保存项；选择“全部保存”，没有丢弃编辑。此次只重载窗口，进程仍为 16862。
2. 为满足完整重启要求，随后从 Nodu Review 原生菜单选择“Quit 见微 Nodu”，确认旧进程 16862 已退出，再使用原工程、原 profile、原端口和原命令行参数重新启动。新进程为 95623，窗口 ID 为 82767。
3. 重启后截图确认新版会话列表入口、圆角消息和“模式 / 模型 / 附件 / 发送”输入工具栏均存在；草稿“要放前看”仍在。

## 文件保护与实际副作用

- `main.c.disk-before-restart.txt`：重载前磁盘原版，442 字节，第 6 行为 `HAL_Init();`。
- `main.c.unsaved-before-restart.txt`：从应用当前文件上下文预览提取的可见未保存编辑，385 字节，第 6 行为“背景”。
- “全部保存”确实把用户原有未保存编辑写入外部测试工程 `Core/Src/main.c`。保存后的文件与上述未保存编辑备份逐字节相同；未擅自将“背景”改回代码。
- 保存框显示两个同名项，但仅当前可见的 main.c 缓冲区单独提取了全文；不能声称两份未知不同文件都已分别备份。
- 源码文件 SHA-256：`dbeb356ba27bea30ae87dd35dd4193f47e9c51f0dcad3b2d1bde3d7003a954e0`。
- 磁盘原版备份 SHA-256：`a49da99762581152f1eeb709ec75ae226562e3d72542bbc51ba89be12fb47f80`。
- 原终端会话没有恢复，界面显示“没有打开的终端”。没有新建终端替代它。

## UI 恢复与操作边界

- Nodu 为同主题对照临时改为明亮主题，完成后已恢复暗色、会话列表收起、AI 教学开启。
- 临时用于提取未保存编辑的 main.c 固定快照附件已移除，恢复“main.c 当前”自动上下文；聊天草稿未发送。
- Cursor 临时展开会话列表并出现过空白 New Agent 标签；结束时无障碍树确认回到 Research paper references、列表收起（Show Chat History 可见），空白标签关闭。原长草稿未改写、未发送。Cursor 部分截图存在视觉帧与无障碍树不同步，未将其当作成功验证的空会话截图。
- 没有修改 Nodu 产品源码，没有执行编译、烧录、硬件运行、模型请求、Git 提交或推送。
- 本目录仅存保护记录和源文件备份。现场界面截图由 Computer Use 返回并显示在会话中，没有导出为本地 PNG/JPEG，不应引用不存在的截图文件。
