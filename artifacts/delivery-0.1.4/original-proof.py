# Identical RAM-only input for original MaixPy IDE and Nodu.
import sensor
import time

namespace = {"__name__": "gc2145_board"}
exec(open("/flash/gc2145_board.py").read(), namespace)
namespace["init_camera"]()
sensor.skip_frames(time=1000)
print("NODU_COMPARE_PROOF_20261021_START")
for frame_number in range(1, 1201):
    img = sensor.snapshot()
    img.draw_string(4, 4, "NODU %04d" % frame_number, color=(255, 0, 0), scale=2)
    if frame_number % 20 == 0:
        print("NODU_COMPARE_PROOF frames=%d" % frame_number)
    time.sleep_ms(100)
print("NODU_COMPARE_PROOF_20261021_DONE")
