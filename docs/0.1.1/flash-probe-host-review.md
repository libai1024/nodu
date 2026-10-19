# Flash ID host codec：独立审查

日期：2026-10-19。范围仅为 [`nodu_flash_protocol.py`](../../desktop/scope-extension/resources/nodu_flash_protocol.py) 与 [`worker_flash_protocol_test.py`](../../desktop/scope-extension/test/worker_flash_protocol_test.py)。审查方未修改实现，未打开串口、复位设备或执行 RAM loader；只运行了不含设备 I/O 的八项协议测试。

**结论：本次审查未发现尚未解决的 P1 / P2 协议或容量认证绕过问题。** 曾发现一处解码器错误后状态恢复缺口，主线程已修正并补回归，本审查复核通过。此结论只覆盖字节编解码，不能作为 loader、串口工作流或当前芯片容量认证。

## 审查版本

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `resources/nodu_flash_protocol.py` | 6,989 | `ae8e4920b722dfef82407a443a3ec97efa631bc195411d90250d813687b44f00` |
| `test/worker_flash_protocol_test.py` | 6,128 | `dec9cf30f4f81e040c6e6b0cefe361a2d01523e5dba1cff914d1e69c06164c33` |

对照版本为 Sipeed kflash `550828c768b16ef329695d3f5eace3f6bcf14af2` 与 ktool `0345aa90d9b3830641373fb4e3ce4edf45d0a46f`。上游用于核对 packet / CRC 与 framing，不加载其 blob。来源和构建边界见[只读来源审计](automatic-flash-source-audit.md)。

本轮对上述同一指纹重新审查 ROM ACK 兼容调整，并独立重跑八项测试；测试前后两文件 SHA-256 完全一致。旧版“ROM 只接受 E0”的结论已由本表和下述复验替换，不能用旧审查自动放行硬件。

## 已解决的发现

**解码器必须在拒绝输入 chunk 后丢弃旧半帧。** 初稿的 `SlipDecoder.feed()` 对非法类型或超过 4,096 B 的 chunk 直接抛错，保留先前 `_buffer` / `_escaped`。例如先收到 `C0 + partial` 后拒绝超大 chunk，同实例仍处于旧帧中；CRC / ID 白名单仍在，但错误后的恢复语义不完整。

现 L65–68 在该入口错误前调用 `_reset()`，与坏 escape、截断 escape 和帧溢出的处理一致。测试 L37–51 已覆盖同实例的超大 chunk、非法类型、坏 escape、溢出之后丢弃无 `C0` 噪声，并从下一合法帧恢复。本审查重新读取修正，并运行全部八项测试通过；该发现关闭。

## 逐项核对

| 项目 | 当前实现与对照结果 |
| --- | --- |
| SLIP 编码 | L43–46 先替换 `DB → DB DD`，再替换 `C0 → DB DC`，加首尾 `C0`；与 [kflash write L750–755](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L750) 和 [RFC 1055 线上格式](https://www.rfc-editor.org/rfc/rfc1055.html) 一致 |
| SLIP 解码 | L70–97 对 escape 后的值只追加一次；`DB` 本身等待下一字节，不直接入 payload。碎片、连续帧、空 delimiter、坏 / 截断 escape 和固定帧界限均有覆盖 |
| 上游接收缺陷 | 固定 [kflash recv_one_return L794–805](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L794) 在解码分支之后仍无条件追加原字节；本库没有复制这一行为。测试 fixture 的 UID 位置包含 `C0 / DB / DC / DD`，并按 1 / 2 / 7 B 等边界分片核对完整恢复 |
| ROM NOP | L106–108 返回 14 B 固定 greeting payload；与 [kflash greeting L916–917](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L916) 去掉 SLIP delimiter 后相同。它与普通 16 B 请求头不同，是有意保留的既有格式 |
| ROM 上传 | L111–125 固定从 `0x80000000` 开始，以最多 1,024 B 分块；C3 / reserved / CRC / address / count 均按小端构造，CRC 覆盖 address + count + data，与 [kflash flash_dataframe L1070–1086](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L1070) 相同。没有调用者自定地址，镜像限 1..65,536 B |
| ROM 启动 | L128–130 固定 C5、`0x80000000`、count=0，CRC 覆盖两字段，与 [kflash boot L976–984](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L976) 相同 |
| stub 请求 | L133–137 只允许整数 D2 / D7 / DE，生成完整 16 B 头，address=0、data_len=0、CRC 覆盖这八字节；没有 Flash 写 / 擦除或任意 SRAM 执行 opcode。原 ktool 某些握手发送较短零填充帧；当前库是为严格校验的源码构建候选生成请求，不承诺任意旧 blob 兼容 |
| ACK | L140–149 要求精确两字节且 opcode 匹配。仅 ROM C2 / C3 接受 DEFAULT=0 或 E0，依据固定 [kflash recv_debug L985–1008](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L985)；stub D2 / D7 仍只接受 E0。错误状态、尾随字节、其他 opcode 和 stub DEFAULT 均拒绝；普通 ACK 不伪造 CRC 字段 |
| DE 响应布局 | L153–173 要求恰为 27 B，`<HHIII` 头为 DE / reserved=0 / checksum / address=0 / data_len=0，payload 为 JEDEC[3]+UID[8]，CRC 比较 `payload[8:]` 的全部 19 B。与 [ktool main.c L206–218](https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/main.c#L206) 及 [isp.h](https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/isp.h) 一致；不是把 data_len 改成 11，也不是按两字节 ACK 解析 DE |
| 完整 ID 白名单 | L33–36 与 L169–173 只接受 `EF4018` / `EF7018`，映射 16,777,216 B；全 00、全 FF、其他完整 ID 均拒绝，不使用任意密度字节指数推算。器件映射依据见[容量状态](device-capacity-status.md) |
| UID 与认证 | 解析器只取 JEDEC，丢弃 UID，不返回 UID 或 `verified`。代码只导入 `binascii` / `struct`，没有 Serial、复位、loader 上传执行或会话认证状态；synthetic fixture 通过不能自动解除设备门禁 |

## 离线验证与保留边界

本审查运行：

```sh
/Users/wangwei/.nodu/python/bin/python -m unittest discover \
  -s desktop/scope-extension/test -p worker_flash_protocol_test.py -v
```

当前指纹复验结果：8 tests，8 passed，0 failures，exit 0；测试前后源码与测试文件哈希均与上表一致。测试覆盖 byte stuffing 分片、错误恢复、完整 ID、CRC / 头部 / 长度拒绝、连续受限 RAM 分块、固定入口、禁止 opcode 和 ACK 状态。新增 ACK 正负例接受 C2 / C3 的 0 / E0，拒绝 D2 / D7 的 0，并保留 E3、长度和未允许操作的拒绝例；均为合成字节，没有真实串口证据。

后续集成仍需另审：镜像源码与哈希认证、串口独占、本次装载 / 请求 / 响应与当前连接的关联、请求超时 / 取消、真实 ROM 与 stub ACK、复位恢复及容量证明的持久化规则。当前解析器只描述收到的字节，不验证 `0x90` 内部交叉检查是否真实执行；该保证须来自被核实的 stub 与实际会话。CRC 只检查传输完整性，不代替这个关联。

ROM DEFAULT 兼容差异已在当前版本消除，stub ACK 仍保持 E0 限定；实际 ROM / stub 往返仍未验收。ROM greeting 精确固定向量、三个允许 stub 请求的完整字段 / CRC 向量可作为后续小型补充覆盖；源码检查未发现当前值有误，不作为本次未解决缺陷。冻结板端 BIN `314f29f2a775607e59659ddf44c50f560bb3f98d3e0df24fad393efe4ddb113d` 未因本次 host 复验重新构建或执行，板端审查见[目标审查](flash-probe-target-review.md)。
