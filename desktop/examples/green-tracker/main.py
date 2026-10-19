"""Nodu / 绿色色块检测

默认：野火 CAM K210 / GC2145 / MaixPy 0.6.3，依赖已有板级 helper。
camera.py 和 thresholds.py 需要能从板端模块路径导入；见 README。
日志来自实际 snapshot/find_blobs；不预设检测数量或 FPS。
"""

import time
from camera import open_camera
from thresholds import GREEN


BOARD_PROFILE = "embedfire-cam-gc2145"
sensor = open_camera(BOARD_PROFILE)
clock = time.clock()
frame_number = 0

while True:
    clock.tick()
    image = sensor.snapshot()
    targets = image.find_blobs(
        [GREEN],
        pixels_threshold=120,
        area_threshold=120,
        merge=True,
    )

    for target in targets:
        image.draw_rectangle(target.rect(), color=(100, 220, 170))
        image.draw_cross(target.cx(), target.cy(), color=(255, 255, 255))

    # 每 15 帧输出一次，避免串口日志淹没调试信息。
    frame_number += 1
    if frame_number % 15 == 0:
        print("frame=%d targets=%d fps=%.1f" % (
            frame_number, len(targets), clock.fps()
        ))
