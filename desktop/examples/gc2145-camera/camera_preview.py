# SPDX-License-Identifier: MIT
"""RAM-only camera check for Embedfire CAM GC2145 / MaixPy 0.6.3.

Requires the existing /flash/gc2145_board.py helper and board pin configuration.
No project modules, LCD, file writes, startup changes or firmware writes.
"""

import sensor

HELPER = "/flash/gc2145_board.py"
MAX_HELPER_BYTES = 65536
FRAME_COUNT = 30

try:
    with open(HELPER, "r") as source:
        code = source.read(MAX_HELPER_BYTES + 1)
except OSError:
    raise RuntimeError("Required GC2145 helper is missing: " + HELPER)
if len(code) > MAX_HELPER_BYTES:
    raise RuntimeError("GC2145 helper exceeds 64 KiB")
namespace = {"__name__": "gc2145_board"}
exec(code, namespace)
del code
initialize = namespace.get("init_camera")
if not callable(initialize):
    raise RuntimeError("GC2145 helper must define init_camera()")
initialize()
sensor.skip_frames(time=1000)

for frame_number in range(1, FRAME_COUNT + 1):
    img = sensor.snapshot()
    if frame_number % 10 == 0:
        print("CAMERA_OK frames=%d width=%d height=%d" % (
            frame_number, img.width(), img.height()
        ))

print("Camera check finished; no startup file was written.")
