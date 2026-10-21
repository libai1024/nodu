# 原版同板对照与 Electron 原生检查

参考应用 MaixPy IDE 0.2.5，目标 Nodu 0.1.4，端口
`/dev/cu.usbserial-3110`，两套应用轮流持有串口。最终已释放设备。
**N1.6 保持 partial，不是完整复刻通过证明**——多数步骤已有两侧可靠证据，
仍缺断电冷重连与若干菜单互动细项。

## 同板对照（2026-10-21 复测，同一 1200 帧对照源 `original-proof.py`）

| 步骤 | 原版可靠证据 | Nodu 证据/结论 |
| --- | --- | --- |
| 连接 | AX 对话框选择 cu.usbserial-3110，状态栏固件 0.6.3；`orig-s3-disabled-window.png` 底栏 | `sidebyside-1021-nodu.json` 连接返回固件 0.6.3、IDE 协议 |
| 运行/出图 | 状态栏 FPS≈7.2，终端 `NODU_COMPARE_PROOF frames=…` 递增至 1200 后 `DONE`，320×240 实时图像 | 同一源运行，`frames=…` 标记到 240+；`sidebyside-1021-nodu-running.png` |
| 禁用/启用 | 勾选"禁用"后帧缓冲裁切两次位哈希完全相同（`orig-s3-fb-a/b.png`，`5eed79cd…`），取消后恢复（`fb-c/d.png` 互不相同）；画面定格 "NODU 1199" | 帧序号 66→66 冻结、启用后推进到 67；`sidebyside-1021-nodu-disabled.png` |
| 四色直方图 | RGB/灰度/LAB/YUV 依次切换并截图（`orig-s4-hist-*.png`），LAB 截图显示三通道完整统计 | 四种均切换并截图（`sidebyside-1021-nodu-hist-*.png`），各含通道统计文本 |
| 停止/REPL | 帧 920 处 `Exception: IDE interrupt` 回溯、`>>>` 提示符返回（`orig-s5-stopped.png` 终端区）；AX 计时器不可靠，不记延迟数值 | 停止 7433 ms（含一次帧尾丢字节的恢复写+丢帧重同步），随后 `print(1+1)`→`2`；`sidebyside-1021-nodu.json` |
| boot.py | 早前 76 B 格式化写入回读（`delivery-0.1.4/original-boot-formatted-readback.json`） | 同源保存同样 76 B，SHA-256 与原版完全相同（`format-parity-after-fix.json`）；自动运行已由标记文件单独验证 |
| 发送文件 | `/sd/n16-send-test.txt` 1053 B，回读 SHA-256 `340e2a07…` 与本地一致 | `saveFile` 同路径写入 1053 B、SHA-256 相同，删除后清单与基线一致 |
| 阈值编辑器 | 帧缓冲来源对话框→编辑器打开，源图带绘制文字、二值图正确跟踪红色区域；L 最小值 20→35，元组实时变为 `(35, 80, -70, -10, -10, 40)`（`orig-s8-threshold*.png`） | 阈值面板六滑块与复制路径早前已测；本轮未在同一冻结图上逐数值比对 |
| 断开 | 断开按钮后端口释放——nodu-device 侧车随即成功打开同端口 | UI 断开返回 disconnected，帧清空 |
| 物理断电重连 | 未执行 | 未执行；软件复位不能替代；**用户指示暂时跳过（2026-10-21）**，待可操作时补做 |

2026-10-21 附加观察：原版停止路径同样依赖"读超时+恢复"语义——`IDE interrupt`
异常注入需要脚本到达可中断点；Nodu 本次停止耗时 7.4 s 主要是真板帧尾丢字节
恢复（7 次恢复写后按丢帧处理、验证流同步）。两侧行为等价：掉帧而非断连。

发送文件证据：原版的 `/tmp/orig-post-list.txt` 与 `/tmp/orig-del.txt` 显示
`nodu-original-20261020.txt` 出现在 `/sd`，内容为
`Nodu original file roundtrip 20261020\n`，断言相同后删除；2026-10-21 追加
同文件 1053 B 双向写入一致性。最终全量清单确认临时文件不再存在。

### 撤回的早期结论

`orig-running-10s.png`、`orig-running-30s.png` 显示“没有图像”，不能证明
连续运行时长。`orig-stopped.png` 显示实时图像、13.3 FPS 和红色停止按钮，
不支持已停止断言；编辑器存在意外换行和未保存标记，不能保证与 Nodu 的
源字节相同。`orig-repl-2.png` 中仍为输入法干扰后的源文本，没有可见的输出
`2`。因此不采用“连续 30 秒稳定、亚秒停止、同源逐字节、REPL=2”的早期报告。
截图在本地原样保留，不重命名或替换为想要的结果。

## Electron 原生检查

使用实际 Electron 进程及独立 `4189` 后端，始终不连接串口。
本地证据目录 `artifacts/e2e-0.1.4/electron/`。

| 检查 | 观察 |
| --- | --- |
| 原生菜单语言 | AX 菜单栏为见微 Nodu、文件、编辑、选择、查看、转到、工具、终端、窗口、帮助 |
| ⌘N | 打开 Untitled Python 文档，原版风格注释头、sensor/image/time 模板；`el-cmdn-template.png` |
| 修改后关闭 | 出现中文保存提示与“不保存/全部保存/取消”；`el-close2.png` |
| ⌘M | AXMinimized 变为 true；恢复后变为 false |
| 窗口→缩放 | 窗口填充屏幕后可恢复原大小 |
| 全屏/退出 | AXFullScreen=true，退出后恢复原大小 |

保存提示使用 Escape 取消；鼠标未成功触发“不保存”，因此没有把这个
按钮的鼠标交互记作通过。测试未保存文档仍留在测试窗口，不涉及板端文件。
原生菜单动作可达，不代表剪贴板历史、打印等所有菜单互动都已验收。

启动器发现并修复继承 `ELECTRON_RUN_AS_NODE` 导致 Electron 被当作 Node
执行的问题：只从子进程环境删除该变量。实际应用成功启动；没有修改用户
全局环境或设置文件。
