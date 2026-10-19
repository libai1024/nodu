# 绿色目标追踪

Nodu 的 MaixPy-v1 入门工作区，演示真实摄像头采集、LAB 色块检测和标记。默认目标是野火 CAM K210 / GC2145、MaixPy 0.6.3（`d8901fd2272f000226f1c1037c1eb7c412b88e66`）。逐帧色块检测没有实现跨帧目标身份跟踪。

## 文件与参数

- `main.py`：采集图像、查找色块并标记目标。
- `camera.py`：按明确板型初始化；默认在 RAM 调用板上已有 GC2145 helper。
- `thresholds.py`：供 `main.py` 导入的唯一绿色阈值定义。
- `board.json`：目标板型、固件来源和依赖声明，不自动连接或部署。

## 在硬件上使用

当前野火板依赖已经存在的 `/flash/config.json` 板级引脚配置及 `/flash/gc2145_board.py` 的 `init_camera()`。示例只读 helper，在 RAM 执行；缺失或初始化失败会报错，不回退到这块 GC2145 已出现超时的裸 `sensor.reset()`。不安装 helper、不写配置、不改启动脚本、不初始化 LCD，也不包含固件烧写。

在 Nodu 中选择真实串口和“野火 K210 CAM · GC2145”板型。先用独立的 [最简相机示例](../gc2145-camera/README.md) 验证采集。运行本项目的 `main.py` 还要求**当前项目的** `camera.py`、`thresholds.py` 已处于板端 Python 模块搜索路径；仅在本机打开这两个文件不会自动部署依赖，运行当前编辑器脚本也不会自动打包整个项目。这里不提供写入 `/flash/main.py`、`/sd/main.py` 或 `boot.py` 的步骤；入口以临时 RAM 脚本运行。

初始 `GREEN` 只是阈值起点，应从真实画面的 LAB 像素和直方图重新标定，再将复制的 tuple 手动粘贴到 `thresholds.py`。界面复制参数不会自动修改源码。固定 GC2145 驱动的 `set_auto_gain()` 尚为 TODO，示例不宣称已锁定增益或白平衡，也不保证不同光照下阈值不变。串口的 targets/FPS 只取自实际采集计算，桌面历史合成画面不能作为检测通过证据。

其他 K210 必须先验证自己的引脚、传感器和固件。需要通用初始化时，明确将 `main.py` 的 `BOARD_PROFILE` 改为 `generic-k210`，并相应调整 `board.json`；该路径未在本轮通用板上验证，不能据固件字符串自动判断物理板型。

## 来源与验证范围

GC2145 helper 的有界初始化在官方 MaixPy IDE 中已采集至少 810 帧真实 320 × 240 画面；默认及无 LCD 的裸初始化均超时，见[诊断与证据](../../../docs/camera-ide-diagnosis.md)。本次仅对修改的示例做本机 Python 语法与 JSON 检查，没有再次连接硬件，也没有验证当前绿色阈值下的实景检测率或 FPS。

固定来源：[MaixPy-v1 gc2145.c](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/gc2145.c) 与同提交 `include/gc2145_regs.h`；两者文件头为 Sipeed Apache-2.0。这里**没有复制或分发其寄存器表/驱动源码**，只调用板上既有 helper；helper 的来源和依赖不能被本项目 MIT 标签替代。

本目录自有示例源码采用 MIT License，见项目根目录许可证。
