import sensor
import time

namespace = {"__name__": "gc2145_board"}
exec(open("/flash/gc2145_board.py").read(), namespace)
namespace["init_camera"]()
sensor.skip_frames(time=1000)
clock = time.clock()
frame_number = 0
print("NODU_COMPARE_START")
while True:
    clock.tick()
    img = sensor.snapshot()
    frame_number += 1
    if frame_number % 20 == 0:
        print("NODU_COMPARE frames=%d camera_fps=%.1f" % (
            frame_number, clock.fps()
        ))
