# 真机验收证据 — 认识开发板（board guide）

日期：2026-10-20（CST）。本文档只记录**真实硬件**结果，与 `board-guide-validation.md`
中的 mock/注入截图严格区分。验收设备：`/dev/cu.usbserial-3120`（野火 K210 CAM），
通过**标准 UI 连接路径**（`NoduDeviceModel.connect()`，设备弹层 → 扫描 → 选择端口
→ 连接）完成；`boardProfile=embedfire-cam-gc2145`、`boardId=2` 为既有配置，未改动。

## 运行环境

- 新建隔离 Electron 实例：后端端口 4198、CDP 4199、userData `/tmp/nodu-board-real-user`、
  workspace `/tmp/nodu-board-real-ws`；**无 `NODU_DEVICE_MOCK`**。
- 既有会话未触碰：native CDP 4196/backend 4195、mock 预览 CDP 4197、浏览器 4188 均原样运行。
- 每次打开串口前 `lsof /dev/cu.usbserial-3120` 均返回无占用（exit 1）。
- 二进制/产物哈希（验收当时，未重建）：
  - Electron binary `059764b26f729ddf5c986f58cc44631e8212eb83b1c2309ff28ac6174cbef157`
  - 前端 bundle `a8dc770d65ecffc16535849db18991c86c67c8219a5c57327f68e0c8dffe09cb`
    （mtime 2026-10-20 00:50:27，晚于全部任务源码改动）
  - `electron-main.js` `344eb20c5eafa7d18702b0eb69aecf6160ee9aae8a1046ef1e03ecbc407b4cca`
  - `nodu_board.py` `aa1566b5d1f3c31aec96f783b8b44b95dca57e0dd4492563137fbc0a088808db`

## 连接与声明读取（成功）

- 连接开始 `2026-10-19T16:57:02.122Z`，`phase=connected` `16:57:03.739Z`（<90s 上限内一次成功）。
- `model.state`（连接后实际值）：
  ```json
  {"architecture":"K210 [Maix:000000000000000000000000]","boardId":2,
   "boardProfile":"embedfire-cam-gc2145","busy":true,
   "capabilities":{"files":true,"firmware":false,"framebuffer":true,"repl":true,"script":true},
   "firmware":"MaixPy 0.6.3","operation":"listFiles","phase":"connected",
   "port":"/dev/cu.usbserial-3120","preview":true,"protocol":"ide","running":false}
  ```
  （`busy/listFiles` 为自动 inspection 正在执行的瞬态，随后 settle。）
- 自动 `inspectBoard()`（与 `model.inspectBoard()` 重试结果逐项一致，schema 无丢失）：
  ```json
  {"status":"declared","source":"/flash/config.json",
   "pins":{"USER_LED":17,"BOOT_KEY":16},
   "peripherals":{"sensor":{"cmos_pclk":23,"cmos_xclk":22,"cmos_href":20,"cmos_pwdn":21,
                            "cmos_vsync":18,"cmos_rst":19,"pin_clk":25,"pin_sda":24},
                  "lcd":{"rst":29,"dcx":27,"ss":28,"clk":26},
                  "sdcard":{"sclk":8,"mosi":7,"miso":9,"cs":6}},
   "issues":[],"declaredType":"embedfire","configName":"embedfire-k210",
   "boardId":"embedfire-cam-gc2145"}
  ```
- `boardLabel` = `野火 K210 CAM`；`error` 空；弹层内经「认识开发板」按钮打开指南后
  popover 自动关闭；目录自动选中 `embedfire-cam-gc2145`；状态行 `板端配置声明：野火 K210 CAM`。
- 真实声明截图（dark 1520，popover 已关闭，非注入）：
  `artifacts/board-guide/20261020-hardware/real-declared-guide.png`
  SHA256 `9fbdfd934106ec6c8f9fa9d836b515c28f8d715b1d19e888bf262dcfc74d1b25`

## 板载 helper 验证（RAM-only，无上传/写盘）

按批准的脚本经 `service.execute` 在 RAM 中 `exec` 本地 `nodu_board.py`
（SHA256 `aa1566b5…08808db`），首次执行返回**真实 stderr**：

```
Traceback (most recent call last):
  File "<stdin>", line 4, in <module>
  File "<string>", line 123, in pin
ValueError: board does not declare pin 'LED'
```

本轮观察到：首次以 `exec(source, fresh_ns)` 执行 helper 时配置查询返回空值；
另一些带顶层 `from Maix import config` 预导入的运行返回了实际配置，并在一次
比较中输出 `same_obj:true`。最后，加入预导入的完整 RAM 脚本成功返回
LED=17、BUTTON=16。相关记录见 diagnostic.json 至 diagnostic5.json、
helper-exec.json。

这些结果证明不同执行上下文下存在行为差异，但尚未确定原因，不能据此排除
helper 的初始化兼容性问题，也不能证明常规 `import nodu_board` 安装路径正常。
本轮没有上传该模块，常规安装/导入与重复冷启动仍未验证。不要将"预导入后成功"
当作无条件兼容结论。

本轮共 7 个连接会话（每次均为有界连接 + 只读调用 + app 断开）：result.json
首个会话（功能验收，首次连接即成功）+ diagnostic.json、diagnostic2..5、
helper-exec.json 共 6 个 helper 诊断会话；不声明只有一次连接。除记录中已有
时间戳外不推导时长。

携带会话级 `from Maix import config` 预导入后，按原脚本逐字重跑成功（verbatim stdout）：

```
NODU_BOARD_API:{"info": {"read_via": "Maix.config runtime cache", "declaration":
"the runtime cache backs onto /flash/config.json; file edits only take effect after
reboot", "type": "embedfire", "config_name": "embedfire-k210", "source":
"/flash/config.json"}, "pins": {"USER_LED": 17, "BOOT_KEY": 16}, "sensor":
{"cmos_vsync": 18, "cmos_rst": 19, "cmos_xclk": 22, "gpio_clk": 0, "cmos_pclk": 23,
"gpio_sda": 0, "cmos_pwdn": 21, "pin_clk": 25, "i2c_num": 2, "reg_width": 8,
"cmos_href": 20, "pin_sda": 24}, "button": 16, "led": 17}
```

- `pin('LED')→17`（USER_LED 别名）、`pin('BUTTON')→16`（BOOT_KEY）、`peripheral('sensor')`
  返回完整 sensor 字段；拷贝隔离由离线单元测试覆盖，本次硬件输出不证明拷贝隔离。
  运行时 sensor 段比解析器白名单多 `gpio_clk/gpio_sda/i2c_num/reg_width`
  等键——解析器只抽取白名单子集，符合设计。

## 清理与最终状态

- 每次会话经 `model.disconnect()` 断开；结束后 `lsof /dev/cu.usbserial-3120` → exit 1（已释放）。
- 隔离窗口保持打开：离线指南页，目录选中 `embedfire-cam-gc2145`，状态 `未连接设备`，
  `phase=disconnected`、`boardLabel=选择开发板`、inspection 已清空。
- 最终截图：`artifacts/board-guide/20261020-hardware/real-final-disconnected-guide.png`
  SHA256 `930a6aee5df143822d4e17d846308fcde46b34d8270b7b1ea7532db149d40e9c`
- 未上传或改写用户 config、boot/main、helper 或固件；正常 IDE 连接按已有固件
  协议创建/删除 ide_mode.conf 临时标记。未调用相机初始化或 GPIO/FPIOA 映射。
  无注入状态。完整时序见
  `artifacts/board-guide/20261020-hardware/{result,helper-exec,diagnostic*}.json`。
- 既有 native/mock/browser 会话及用户工作区全程未触碰；无提交。
