"""K210 camera setup; default: Embedfire CAM / GC2145 / MaixPy 0.6.3.

Uses the existing device helper in RAM. It never installs or changes that file.
The generic path must be selected explicitly and needs separate board setup.
"""

import sensor

BOARD_HELPER = "/flash/gc2145_board.py"
MAX_HELPER_BYTES = 65536


def open_camera(board_profile="embedfire-cam-gc2145"):
    if board_profile == "embedfire-cam-gc2145":
        # The existing helper skips the C driver's unbounded default-table
        # loop, replays the fixed 646-pair table, then starts RGB565/QVGA.
        try:
            with open(BOARD_HELPER, "r") as source:
                code = source.read(MAX_HELPER_BYTES + 1)
        except OSError:
            raise RuntimeError("Required GC2145 helper is missing: " + BOARD_HELPER)
        if len(code) > MAX_HELPER_BYTES:
            raise RuntimeError("GC2145 helper exceeds 64 KiB")
        namespace = {"__name__": "gc2145_board"}
        exec(code, namespace)
        initialize = namespace.get("init_camera")
        if not callable(initialize):
            raise RuntimeError("GC2145 helper must define init_camera()")
        initialize()
    elif board_profile == "generic-k210":
        # Opt-in only: bare reset is not the verified GC2145 path.
        sensor.reset()
        sensor.set_pixformat(sensor.RGB565)
        sensor.set_framesize(sensor.QVGA)
    else:
        raise ValueError("Unsupported camera board profile: " + str(board_profile))

    sensor.skip_frames(time=1000)
    # GC2145 set_auto_gain() is a no-op in the pinned firmware. Do not claim
    # locked gain/white balance here; calibrate LAB thresholds in real light.
    return sensor
