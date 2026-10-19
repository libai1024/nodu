# GC2145 最简相机检查

目标为已经配置好的野火 CAM K210 / GC2145、MaixPy 0.6.3（`d8901fd2272f000226f1c1037c1eb7c412b88e66`）。`camera_preview.py` 是单文件 RAM 示例，不依赖本机项目里的 Python 模块；需要板上**已有** `/flash/config.json` 引脚配置和 `/flash/gc2145_board.py`，后者必须提供 `init_camera()`。

在 Nodu 连接真实串口并选择“野火 K210 CAM · GC2145”，打开 `camera_preview.py` 临时运行。它读取已有 helper 到独立 RAM namespace，初始化 RGB565 / 320 × 240、24 MHz、双缓冲，等待设置生效，然后实际采集 30 帧；每 10 帧输出一次实际尺寸，结束后返回。缺少 helper 或采集失败会报错，不尝试通用 reset、不安装文件、不写 `boot.py` 或任何 `main.py`，也不保存图像、配置或烧录固件。

官方 MaixPy IDE 可在帧缓冲区查看 `img`；Nodu 在普通脚本运行时会暂停后台预览采集，脚本结束后可使用相机预览。示例没有测量或预填 FPS，也不模拟真机画面。需要持续循环时可另行编辑脚本，但本例默认有界执行，便于先确认初始化与采集。

初始化方案的真实依据是同一官方 IDE 中 helper 连续至少 810 帧正常，默认和无 LCD 的裸 `sensor.reset()` 均超时，见[诊断记录](../../../docs/camera-ide-diagnosis.md)。2026-10-19 已在 Nodu 原生 App 的“运行到设备”按钮实际执行本文件：输出 `CAMERA_OK frames=10/20/30 width=320 height=240` 后正常结束；随后从 Nodu“启动相机”取得连续真实 JPEG（记录到第205帧）并暂停/断开。证据位于 `artifacts/camera-diagnosis/20261019/nodu-camera-example-30frames.jpg` 与 `nodu-camera-preview-regression.jpg`。这验证当前组合，不扩大为其他板卡或模式的通过。

helper 按固定官方 [gc2145.c](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/gc2145.c) 和同提交 `include/gc2145_regs.h` 的寄存器表作有界重放，两份官方文件头均为 Sipeed Apache-2.0。本目录没有复制或分发该表/驱动，只调用用户设备现有 helper；本目录自有示例代码为 MIT。该方案不宣称兼容其他摄像头、板卡或任意 MaixPy 固件。
