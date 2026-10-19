# MaixPy IDE：GC2145 默认初始化超时诊断

日期：2026-10-19。环境为本机官方 MaixPy IDE 0.2.5、野火 CAM K210 / GC2145、MaixPy 0.6.3（固定源码提交 `d8901fd2272f000226f1c1037c1eb7c412b88e66`）。实机操作与画面由主线程记录；本文件编写者只读核对已有脚本和固定源码，没有操作 UI、串口或修改板端文件。

**结论：相机在同一个官方 IDE 中能够持续输出真实彩色 320 × 240 图像。默认初始化路径会超时，既有 GC2145 helper 的 RAM 初始化路径可用；这次修复不需要更换相机或重新烧录固件。** 本次 `Sensor Timeout` 与此前板子倒放导致的暗帧是两件独立事件，不能用此前物理原因解释这次超时。

## 本次 A/B 实测

| IDE 中执行的脚本 | 本次结果 | 能支持的判断 |
| --- | --- | --- |
| 安装包默认 HelloWorld：`lcd.init(freq=15000000)` → `sensor.reset()` → RGB565/QVGA → `skip_frames(time=2000)` | reset 返回，`skip_frames` 报 `Sensor Timeout` | 默认相机初始化不能完成实际采集 |
| IDE 新建的相机默认脚本，去掉 LCD 初始化 | 同样采集超时 | **LCD 初始化不是这次超时的唯一原因**；不能仅去掉 LCD 就声称已修复 |
| 同一 IDE 中仅在 RAM 执行板上已有 `gc2145_board.py` 的 `init_camera()`，再采集 | 出现真实彩色桌面场景，320 × 240；日志连续 `CAMERA_OK 30` 至至少 `810` 帧，脚本 clock 约 12.8–13.2 FPS | 当前相机、板端采集和官方 IDE 图像显示路径可以共同工作；应沿用已验证的板级初始化 |

证据：[默认路径超时截图](../../artifacts/camera-diagnosis/20261019/maixpy-default-sensor-timeout.jpg)、[helper 路径实时画面](../../artifacts/camera-diagnosis/20261019/maixpy-gc2145-live.jpg)、[展开终端的画面](../../artifacts/camera-diagnosis/20261019/maixpy-live-with-log.jpg)、`artifacts/camera-diagnosis/20261019/maixpy-live-state.txt`（仅本地保留）。日志 reset 均检测到 `gc2145`；成功 helper 报告 `registers=646/freq=24000000/f2=15/format84=6`。IDE 帧缓冲区瞬时 FPS 曾显示 6、7、22.3；瞬时显示和脚本 clock 口径不同，均不扩展为稳定帧率基准，也不代表 Nodu 的低速 JPEG 快照帧率。

诊断结束时，主线程已停止该 RAM 脚本并从 IDE 断开；IDE 窗口、代码和最后图像保留。没有固件烧写或 RAM Flash 探针加载。

## 脚本与源码的具体差异

本机安装包默认脚本位于 helloworld.py（本机 `/Applications/MaixPy IDE.app/Contents/Resources/examples/01-Basics/helloworld.py:11`）：第 11 行初始化 LCD，第 12 行直接 `sensor.reset()`，第 14–16 行配置 RGB565/QVGA 并跳帧。

Nodu 已成功使用的 [startCamera](../../desktop/scope-extension/resources/nodu_device_worker.py#L803) 在第 810–815 行读取板上已有 `/flash/gc2145_board.py` 到独立 RAM namespace，调用 `init_camera()`，然后 `skip_frames(time=1000)`；没有安装或改写 helper。其本机部署源为 gc2145_board.py（本机 `/opt/homebrew/share/maixpy-k210/demos/gc2145_board.py:67`），关键流程如下：

- 第 67–77 行：24 MHz、双缓冲，`sensor.reset(set_regs=False, choice=2)`；保留 C 层引脚、总线和 GC 检测，跳过 C 默认寄存器重放。
- 第 78–85 行：先停止采集，按明确字节长度重放 646 对官方默认寄存器。
- 第 86–91 行：配置 RGB565/QVGA，选择 page 0、设置 `F2=0x0F`，等待 30 ms 后重新运行。

这些改变作为一个整体已实测有效；本次 A/B 没有逐项隔离双缓冲、choice、寄存器重放和启停时序，不能把结果归功于其中某个单独参数。

固定固件源码缓存位于 `/tmp/nodu-current-firmware-audit/MaixPy-v1-d8901fd2272f000226f1c1037c1eb7c412b88e66/`。本轮只读核对确认：

| 源码位置 | 可确认的事实 |
| --- | --- |
| [gc2145.c:32](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/gc2145.c#L32) | 第 37 行以 `sensor_gc2145_default_regs[index][0] != 0` 判断循环结束；未按数组长度设界。 |
| [gc2145_regs.h:20](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/include/gc2145_regs.h#L20) | 默认表从第 20 行开始，第 757–758 行以 `{0xFE,0x00}` 后直接结束；有效项共 646 对，没有 address=0 的终止项。只读解析比较证明 helper 的 1292 字节表与该默认表逐字节一致。 |
| [sensor.c:672](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/sensor.c#L672) | 第 702–707 行只有 `set_regs=True` 才调用传感器的默认 reset 函数；helper 的 `set_regs=False` 绕开该表循环。 |
| [py_sensor.c:36](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/py/py_sensor.c#L36) | 默认 `set_regs=True`、`dual_buff=False`、`choice=0`，与 helper 的明确参数不同。第 154–156 行表明 `skip_frames` 内实际调用 snapshot，采集失败才抛 `Sensor Timeout!!`；reset 返回不能证明已有图像帧。 |

**缺终止哨兵与循环无长度界是已核实的源码缺陷，存在越界读取风险；本次没有指令追踪、总线抓取或越界地址记录，不能声称已经捕获这次超时实际发生的越界访问，更不能给出实际多写了哪些寄存器的结论。** 当前证据支持“默认路径失败，绕开该路径的完整板级 helper 成功”。固定原文还可由 [gc2145.c](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/gc2145.c#L32) 和 [gc2145_regs.h](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/include/gc2145_regs.h#L20) 追溯；临时缓存路径将来可能被清理。

## 引脚与 LCD 的边界

本机适配源 embedfire-config.json（本机 `/opt/homebrew/share/maixpy-k210/firmware/embedfire-config.json`） 的 sensor 配置为 PCLK=23、XCLK=22、HREF=20、PWDN=21、VSYNC=18、RST=19，I2C2 SCLK=25/SDA=24；LCD 使用 CLK=26、DCX=27、SS=28、RST=29，二者没有上述物理引脚重叠。

固定 [sensor.c:128](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/sensor.c#L128) 读取 `sensor` 配置，第 572–591 行应用引脚和总线；[py_lcd.c:117](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/py/py_lcd.c#L117) 另读 LCD 配置。历史 02_camera.py:23（本机 `/opt/homebrew/share/maixpy-k210/demos/02_camera.py:23`） 也先初始化 LCD 再调用 helper，demo-camera.log:4（本机 `/opt/homebrew/share/maixpy-k210/logs/demo-camera.log:4`） 记录同样的 646 对初始化和连续 66 帧成功。本次无 LCD 脚本仍失败，因此没有依据为这次修复盲改引脚或配置。

## 当前可用做法

在 IDE 临时运行中复用已有 helper，再执行 `sensor.snapshot()`；不保存为启动脚本、不写配置、不更换固件：

```python
import sensor
_camera_ns = {'__name__': 'gc2145_board'}
with open('/flash/gc2145_board.py') as _camera_file:
    exec(_camera_file.read(), _camera_ns)
_camera_ns['init_camera']()
sensor.skip_frames(time=1000)
while True:
    img = sensor.snapshot()
```

这是当前板型和固定固件上已验证的 RAM 初始化方案。后续若修 C 驱动，应另做有界表修正及独立回归；本次没有以相机诊断为由重新烧录、写入寄存器持久配置或操作 Flash 探针。
