# Camera recheck — 2026-10-19 (Asia/Shanghai)

The user confirmed that the lens was unobstructed and facing a lit scene, then explained that the earlier black image occurred while the board was placed upside down. No driver, sensor register, firmware, or startup file was changed for this recheck.

Using the existing NoduDeviceServer and Python worker, connected the selected Embedfire CAM K210 / GC2145 profile on `/dev/cu.usbserial-3120`, initialized the existing board helper in RAM, and received six JPEG frames. All were 320 × 240, with lengths from 3,331 to 3,402 bytes. Viewed frames 1 and 6 directly: both show a cardboard box and surrounding objects, rather than a uniform black image.

Five subsequent uncompressed snapshots reported LAB L means of 44–52 and standard deviation 22, compared with the previous dark capture's mean 6–7 and standard deviation 0. The camera capture, JPEG conversion, and service transport therefore produced a usable scene in this recheck. This does not measure sustained FPS, prove inference accuracy, or complete native App camera acceptance. Preview was disabled and the service disconnected afterwards.

Evidence:

- `camera-recheck-2026-10-18T18-35-09-333Z-1.jpg` through `-6.jpg`: original device JPEG bytes received through the service.
- `camera-recheck-2026-10-18T18-35-09-333Z.txt`: initialization logs and snapshot statistics.
- `camera-diagnosis.txt`, `camera-real.jpg`, and `app-camera.jpg`: retained historical dark-image evidence, not the current camera outcome.

Firmware backup certification and flashing remain separate and unverified. This camera check does not establish actual Flash capacity or authorize bypassing the existing capacity guard.
