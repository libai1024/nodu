# GC2145 camera check - RAM only; no files are written.
import sensor, image, time
_camera_ns = {"__name__": "gc2145_board"}
with open("/flash/gc2145_board.py", "r") as _helper:
    exec(_helper.read(65537), _camera_ns)
_camera_ns["init_camera"]()
sensor.skip_frames(time=1000)
clock = time.clock()
_frames = 0
while True:
    clock.tick()
    img = sensor.snapshot()
    _frames += 1
    if _frames % 30 == 0:
        print("CAMERA_OK", _frames, img.width(), img.height(), clock.fps(), img.get_statistics())
