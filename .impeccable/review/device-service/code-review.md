# Nodu 基础设备服务代码审查

审查日期：2026-10-19。只读审查基础设备服务及随后落盘的固件备份/烧写实现；审查者未执行构建、测试、串口或硬件操作。以下发现均已由实现方修复，并经最终源码复核。**本轮未发现尚未解决的高置信 P1/P2；这是静态审查结论，不构成固件烧写或数据恢复的真机验收。**

## 修复复核状态

| 已报告问题 | 源码复核结果 |
| --- | --- |
| 串口枚举 await 后重新连接已取消请求 | 已新增 connectionEpoch，并在 await 后复核 |
| 非超时 raw REPL 传输异常仍留 connected | 已新增 ProtocolError 及 _exec/_start_raw 恢复状态处理 |
| 256 KiB 上传不足 20 秒预算 | 已增加按实际 UTF-8 字节与串口速率计算的上传预算，并调整 Node 超时 |
| RPC 暴露内部方法 | 已改为 null-prototype 公开方法 facade |
| 最后一个前端刷新导致后台 Flash 被 idle cleanup 杀掉 | 已保留 flashTask 并推迟 idle cleanup/onStop 释放 |
| 备份取消的 20 秒波特率恢复超过 Node 10 秒预算 | Node stop/disconnect 已调整为 45 秒 |
| 文件筛选遗漏 SD 配置/隐藏文件/模型资源 | eligible_file 已改为备份全部常规文件 |
| 烧写成功只校验固件，未验证用户文件 | 已在返回 verified 前增加逐文件长度与 SHA-256 核对 |
| 确认的备份目录被另一客户端的新备份静默替换 | 协议、model、Node 已显式传递并比对 confirmedBackupDirectory |
| standalone SD 文件备份被删除/篡改后仍允许烧写 | validate_backup 已在释放串口前重验所有常规文件长度、SHA-256 与受控本地路径 |
| Flash 期间普通 RPC 排队后短超时杀掉 worker | Node request 已在 flashTask 期间拒绝其他 worker 操作，并拒绝普通请求并行排队 |

最终复核定位：`src/node/nodu-backend-module.ts:15–22` 的 RPC facade；`src/node/nodu-device-server.ts:40–50` 的闲置释放保护、`:113–116` 的调度门禁、`:142–154` 的取消与连接 epoch、`:175–181` 的确认目录绑定；`src/browser/nodu-device-client.ts:204–208` 的确认目录捕获与传递；`resources/nodu_firmware.py:194–231` 的恢复材料预校验；`resources/nodu_device_worker.py:1083–1084` 的 ISP 前调用与随后返回 verified 前的用户文件核对。

下文保留首次基础审查的触发说明，均为**已修复历史发现**。

## [P2] 串口枚举之后仍可能执行已经取消的连接

位置：`desktop/scope-extension/src/node/nodu-device-server.ts:124–126`。

`connect()` 先等待 `listPorts()`，但 `stop()`、`disconnect()` 没有使这次 Node 层连接尝试失效。若用户在枚举执行期间取消，worker 的 `do_listPorts()` 不会在返回前重检 generation，枚举仍能成功返回；worker 处理优先断开后，原 `connect()` continuation 又发送一个取得新 generation 的连接请求。结果是停止/断开已经成功，随后串口又被打开。连接尝试需要独立取消标识，并在枚举 await 返回后验证。

## [P2] 非超时传输失败仍将未知 raw REPL 会话作为可用连接

位置：`desktop/scope-extension/resources/nodu_device_worker.py:485–489`，触发位置 `:263–264`。

异常处理仅在错误文字含 `timeout` / `timed out` 时将会话置为 `error`。例如执行持续输出超过 4 MiB 的 REPL 代码时，`read_until()` 在尚未消费 stdout/stderr EOF 的位置抛出输出超限错误；handler 仍保留 `phase='connected'`。下一个 execute/listFiles/readFile 将直接进入尚未同步的 raw parser，可能把用户输出中的 `>` 当提示符，丢失命令或继续失败。串口拔出引发的普通 `SerialException` 同样保留 connected。需要区分完整消费响应后的板端 Python 异常与传输/协议异常；后者应进入恢复状态或关闭会话。

## [P2] 允许的 256 KiB 脚本超过固定串口的上传时间预算

位置：`desktop/scope-extension/resources/nodu_device_worker.py:457–459`，上传实现 `:273–276`。

`runScript` 和 `execute` 使用默认 20 秒操作 deadline，但入口允许 256 KiB UTF-8 代码，Node 又固定 REPL 为 115200 波特率。115200 / 8N1 发送 256 KiB 至少需要 22.76 秒，尚未计入握手、分块等待和执行；接近大小上限的合法脚本必然在发完代码前被 `check()` 中止。应让上传和执行预算覆盖声明支持的最大脚本，并同步调整 Node 请求 timeout。

## [P2] RPC 直接暴露了内部调度和关闭方法

位置：`desktop/scope-extension/src/node/nodu-backend-module.ts:11–15`。

连接处理器直接把 `NoduDeviceServer` 实例作为 RPC target。当前 Theia `node_modules/@theia/core/lib/common/messaging/proxy-factory.js:131–134` 会执行 `target[method](...args)`，TypeScript `private` 不会在运行时隐藏方法。因此调用方可以 RPC 调用 `request()`，绕过 Node 的路径/端口检查及固定参数，也可以直接调用 `shutdown()` / `failWorker()` 立即杀掉 worker。这使协议声明中的公开方法与实际可调用边界不一致；尤其新增不可中断固件操作不能靠公开 stop/disconnect 的检查形成保护。应提供只绑定协议公开方法的 RPC facade。

## 已核对且未发现材料性问题的边界

- `scope-workbench.tsx` 从 Monaco 实时 model 读取运行代码，包含未保存编辑内容。
- 读取到本地使用 `createFile(overwrite:false)`，未发现覆盖现有本地文件或 dirty 编辑缓冲区的路径。
- 基础连接及停止未调用 `FW_VERSION` 或切换 IDE 模式；未发现服务主动写入用户启动文件。
- 物理 profile 独立保存，未被固件 `uname` 改写；文件传输的 2 MiB 大小校验在 Node 与 worker 两层均存在。
