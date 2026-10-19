# MaixPy IDE 0.2.5 私有参数（阶段 0.3 证据）

日期：2026-10-19。对象：`/Applications/MaixPy IDE.app/Contents/PlugIns/libOpenMV.dylib`（Mach-O x86_64，保留 C++ 符号）。方法：`objdump -d` 反汇编，加上 `otool -Iv` 的导入桩映射和 `nm` 符号，只观察行为参数。固件端以 MIT 的 `MaixPy-v1@d8901fd:components/micropython/port/src/omv/ide_dbg.c` 为准。

## 1. Sipeed 在 af179e44 之外新增的函数

用二进制符号表与 `openmv/qt-creator@af179e44` 插件源码比对，下列函数在源码里不存在，属于 Sipeed 的改动：

- `OpenMVPlugin::OnBoard{KD233,MaixBit,MaixBitmic,MaixDock,MaixGoD,MaixGoE,Maixduino,M5stick,TWatch}Selected`、`setBoardCheckbox`、`loadBoardConfig`、`saveBoardConfig`（`/boardconfig.txt`）
- `OpenMVPlugin::saveBootPy2Board`、`saveFile2Board`、`fileSaveResult`、`scriptSaveResult`
- `OpenMVPluginIO::setBoard`、`ideMode`、`waitIdeMode`、`fileSave`、`hardReboot`，以及对应的 `is/cancel/wasCanceled*` 和 `*Done`

## 2. 板型 ID（`OnBoard*Selected` 写入 `this+0x28`）

| 菜单 | ID |
| --- | --- |
| Kendryte KD233 | 0 |
| Sipeed Maix Bit( old ) | 1 |
| Sipeed Maix Dock | 2 |
| Sipeed Maix Go( open-ec & new CMSIS_DAP ) | 3 |
| Sipeed Maix Go( Old CMSIS-DAP ) | 4 |
| Sipeed Maixduino | 5 |
| Sipeed Maix Bit( with Mic ) | 6 |
| M5StickV | 7 |
| T-Watch | 8 |

选择后写入用户配置 `/boardconfig.txt`，下次启动由 `loadBoardConfig` 读回。

## 3. 连接复位时序（`OpenMVPluginIO::setBoard(id, nullptr, 0)`，0x5e1ac）

Qt 的 `setDataTerminalReady(true)` / `setRequestToSend(true)` 表示信号有效。每一步之后 `QThread::msleep(100)`：

1. DTR=0，RTS=0
2. DTR=`bit(0xF9, id)`，RTS=`bit(0x06, id)`；id > 7 时 DTR=0、RTS=1
3. DTR=RTS=`(id == 4)`

展开：

| 板型 | 第 2 步 DTR / RTS | 第 3 步 DTR / RTS |
| --- | --- | --- |
| KD233 (0) | 1 / 0 | 0 / 0 |
| Bit old (1) | 0 / 1 | 0 / 0 |
| Dock (2) | 0 / 1 | 0 / 0 |
| Go open-ec (3) | 1 / 0 | 0 / 0 |
| Go old CMSIS-DAP (4) | 1 / 0 | **1 / 1** |
| Maixduino (5) | 1 / 0 | 0 / 0 |
| Bit with Mic (6) | 1 / 0 | 0 / 0 |
| M5StickV (7) | 1 / 0 | 0 / 0 |
| T-Watch (8) | 0 / 1 | 0 / 0 |

复位完成后排队一条命令：等待文本 `[MaixPy] init end`，超时 10000 ms（命令参数块 `0x116a20` = `{0, 0, 10000, 0}`，外加一个标志字节）。

串行终端打开串口时也会复位（`setBoard(id, terminal, 0)`，0x5e124）：id ∈ {0,3,5,6,7} 时 (0,0)→(1,0)→(0,0)；id = 4 时 (0,0)→(1,1)→(1,1)→(0,0)；其余 id 是 (0,0)→(0,1)→(0,0)。每步 100 ms。

## 4. 进入 IDE 模式（`OpenMVPluginIO::ideMode`，0x5e4b0）

`snprintf(buf, 0x96, fmt, 1500000, 2048)`，其中 `fmt` 为：

```
from machine import UART\r\nrepl = UART.repl_uart()\r\nrepl.init(%d, 8, None, 1, read_buf_len=%d, ide=True)\r\n\r\n
```

即 **1,500,000 bps，`read_buf_len=2048`**。命令参数块 `{0, 500, 5000, 200}`，随后一条期待 `repl` 回显的命令 `{25, 200, 500, 300}`。之后主机端切到 1.5 M（日志 `change baudrate`）。

`waitIdeMode`（0x5e980）：发送 `0x30 0x8D` + 长度 4（`USBDBG_QUERY_STATUS`），期待 4 字节；固件返回 `0xFFEEBBAA`（ide_dbg.c:290）。命令参数块 `0x116a10`，重试计数 `0x1f`。失败时提示“Connect fail, board ide mode no ack”。

进入 IDE 模式时固件写 `/flash/ide_mode.conf`（`ide_dbg_init2`，ide_dbg.c:166）；收到 `FW_VERSION` 时删除（ide_dbg.c:447）。

## 5. 保存文件 / boot.py（`OpenMVPluginIO::fileSave`，0x5fa80）

先 `scriptStop`。负载按固件 `ide_save_file` 的格式组装（ide_dbg.c:645 起）：

```
[32 B SHA-256(后续全部字节)] [文件名, NUL 结尾, 补齐到 4 字节] [文件内容]
```

主机用 `QCryptographicHash::hash(..., Sha256)`。命令：`0x30 0x07` + 负载长度（`USBDBG_FILE_SAVE`），接着轮询 `0x30 0x88`（`FILE_SAVE_STATUS`，4 字节）。固件状态码：0 成功，1 接收中，2 内存不足，3 打开失败，4 写入失败，5 待保存，6 校验失败（日志“parity check fail, try again”），100 内部错误。

- **保存到 boot.py**（`saveBootPy2Board`）：先询问“Strip comments and convert spaces to tabs?”，文件名为 `boot.py`（相对路径，由固件 VFS 解析）；进度“Sending... Please wait...”，成功日志“save script as boot.py OK”。
- **发送文件到开发板**（`saveFile2Board`）：弹出“Open File”（过滤器 `(*.*)`）选本地文件，走同一条 FILE_SAVE 路径；失败提示“Failed to open file”。**更正**：这不是另外一套 REPL 分块协议，而是 IDE 协议的 FILE_SAVE，`hash:` 只用于日志。

## 6. 其他已确认的字符串参数

- 版本检查：`https://dl.sipeed.com/MAIX/MaixPy/ide/maixpy_ide_version.txt`；资源包：`.../maixpy_ide_resources_version.txt`、`.../maixpy_ide_resources_%1.%2.%3/maixpy_ide_resources_%1.%2.%3.zip`。
- 帮助：文档 `https://maixpy.sipeed.com/`，论坛 `https://bbs.sipeed.com/`，固件发布页 `https://github.com/sipeed/MaixPy/releases`，更多示例 `https://github.com/sipeed/MaixPy_scripts`。
- 二维码 / DataMatrix / 条码生成器：`http://www.google.com/search?q=qr+code+generator` / `data+matrix+generator` / `barcode+generator`。
- 录像文件头：`OMV IMG STR V1.0`。
- 字符串里还有 `execfile("/main.py")` 和 `Run "/main.py"`，入口待阶段 2 确认（菜单里没有）。

## 7. 待阶段 2 补充

- 命令参数块的第 4 个整数和标志字节的含义（需要分析 `OpenMVPluginSerialPort_private::command`，0x585a0）。
- 帧缓冲和 TX 缓冲的轮询间隔、重连次数。
- 野火 CAM（CH340）在原版里应该选哪个板型：在真板上逐个测试 9 种复位时序。
