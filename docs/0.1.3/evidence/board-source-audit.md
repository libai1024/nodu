# 板型与引脚：源码核查

2026-10-19。本记录区分公开 OpenMV 上游、MaixPy 固件与 MaixPy IDE 发布版，避免将三者当作同一实现。

## 核查对象与结论

- `openmv/qt-creator@af179e44cddf396a5ab618792d71e9de5cc67032`：
  `src/plugins/openmv/openmvplugin.cpp:4168–4204` 调用 `getArchString()`，解析 `[(板型):(ID)]` 并设置 `m_boardType`。
  `1288–1303` 的 “About OpenMV Cam” 打开本地 `html/_images/pinout.png`。
  `3542–3560` 通过 `firmware/boards.txt` 映射固件目录。这是固件报告的身份与静态资料入口，不是扫描 GPIO 推断 PCB。
- `sipeed/MaixPy-v1@d8901fd2272f000226f1c1037c1eb7c412b88e66`：
  `components/micropython/port/src/omv/boards/MAIX/omv_boardconfig.h:45–46` 固定 `OMV_ARCH_STR="K210"`、`OMV_BOARD_TYPE="Maix"`；
  `ide_dbg.c:270–274` 返回该字符串，UID 三段为零且注释为 TODO。
  同一固件返回的 `K210 [Maix:000000000000000000000000]` 不能区分物理板型，也不能作为设备唯一 ID。
- MaixPy IDE 0.2.5 的 Sipeed 改动不全在上述公开 OpenMV 提交中。
  原菜单 0–8、配置持久化、DTR/RTS 复位时序的证据来自既有发布版二进制核查，见 [original-private-params.md](original-private-params.md)。
  不能将这份发布版证据写成公开仓库已有对应源码。

## 配置与引脚机制

- 固件 `components/micropython/port/src/Maix/Maix_config.c` 中 `MAIX_CONFIG_PATH` 为 `/flash/config.json`；
  `maix_config_cache()` 读取并缓存 JSON；`maix_config_get_value()` 从缓存字典取值。磁盘文件不一定等于当前运行时已缓存的值。
- `builtin_py/board.py:13–21` 从 `Maix.config.get_value('board_info', None)` 加载属性；缺失时只回退 `BOOT_KEY=16`。
  导入 `board_info` 本身并不把全部引脚注册到 FPIOA。
- `builtin_py/fpioa_manager.py:12–23` 的 `register(pin, function, force=True)` 默认允许重映射；
  `force=False` 检查的是指定功能是否已在其他引脚使用，并非完整的外设或引脚冲突管理。
- `src/omv/sensor.c:128–151, 566–593` 在相机初始化时读 `sensor` 配置并设置 FPIOA；
  不是导入 `board_info` 就完成所有外设配置。
- `components/boards/config/readme.md` 明确说明 `config.json` 用于 LCD、sensor、SD 的不同硬件 IO 配置。
- `sipeed/MaixPy-v1_scripts@8d7c5f98ba654d226f433d31718d852674cab08d` 的
  `board/config_maix_bit.py`、`config_maix_dock.py`、`config_maix_go.py`、`config_maix_duino.py` 给出不同的 `type` 和 `board_info`；
  文件缺失或类型不符时，脚本会写配置并复位。这是用户指定配置，不是硬件自动识别。
  本地移植只读取配置，不执行这些配置写入脚本。

## 电气与可视化依据

- 野火现有设备配置：`artifacts/ide-diag/config.json`，`type=embedfire`、`config_name=embedfire-k210`；
  `USER_LED=17`、`BOOT_KEY=16`。这是当前板端文件快照，不证明全部野火硬件修订一致。
- 官方手册：https://doc.embedfire.com/k210/quick_start/zh/latest/k210/peripheral/pin/pin.html
  明确引脚组 1 的 IO 为 3.3V，引脚组 2 的 IO 为 1.8V。
  组 1 包含 5V 电源触点，不意味着 IO 可承受 5V。
- 引脚表来自官方 `/_images/pin1.png` 与 `pin2.png`，逐项转录至 `nodu-board-data.ts`；
  `/_images/pin.png` 仅作为原创 Blender 教学模型的部件布局参考，不将原照片重新打包。
- 模型不是机械 CAD；未核实尺寸、PCB 修订、单孔编号方向时不作精度或接线方向保证。
  表格区分连接器触点号、SoC IO 号、GPIO/GPIOHS 功能通道，电源与 GND 不生成 GPIO 代码。

## 移植边界

“板端配置声明”“手动浏览资料”“当前连接”保持独立。未知/冲突/损坏配置不能静默套用野火引脚。
不靠 VID/PID 判定 PCB，不依据 `os.uname()` 或相机型号确认整板型号，不自动试多个复位序列。
不同硬件烧相同系统时，若没有板端身份配置或独立硬件身份，首次必须由用户确认实物。
复位方式和相机适配不因介绍页选板而变化。
