import sensor
import time

namespace = {"__name__": "gc2145_board"}
exec(open("/flash/gc2145_board.py").read(), namespace)
namespace["init_camera"]()
sensor.skip_frames(time=1000)
THRESHOLD = (20, 80, -70, -10, -10, 40)
MIN_PIXELS = 240
print("NODU_COLOR_START min_pixels=%d threshold=%s" % (MIN_PIXELS, THRESHOLD))
for frame_number in range(60):
    img = sensor.snapshot()
    blobs = img.find_blobs([THRESHOLD], pixels_threshold=MIN_PIXELS,
                          area_threshold=120, merge=True)
    for blob in blobs:
        img.draw_rectangle(blob.rect())
        img.draw_cross(blob.cx(), blob.cy())
    if frame_number % 10 == 0:
        print("NODU_COLOR frame=%d blobs=%d min_pixels=%d" % (
            frame_number, len(blobs), MIN_PIXELS
        ))
    time.sleep_ms(150)
print("NODU_COLOR_DONE")
