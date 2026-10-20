# S5 execution recipe — lead-authored, no product edits

All source below is entered in an untitled editor through new-file/template UI.
Run and stop through Nodu UI. Read-only model/log subscriptions may observe;
they must not inject success, frames, or device state. Save exact editor bytes,
per-run logs and observed UI errors. Do not infer physical LED/LCD output.

## Single LED, first version

Save local artifact as `student-led.py`, run to completion:

```python
import time
from fpioa_manager import fm
from Maix import GPIO

PERIOD_MS = 500
fm.register(17, fm.fpioa.GPIOHS1, force=True)
led = GPIO(GPIO.GPIOHS1, GPIO.OUT)
started = time.ticks_ms()
try:
    for step in range(8):
        value = step % 2
        led.value(value)
        print("NODU_LED step=%d value=%d elapsed_ms=%d period_ms=%d" % (
            step, led.value(), time.ticks_diff(time.ticks_ms(), started), PERIOD_MS
        ))
        time.sleep_ms(PERIOD_MS)
finally:
    led.value(1)
    fm.unregister(17)
print("NODU_LED_DONE")
```

Modify the existing editor's `PERIOD_MS = 500` to `PERIOD_MS = 150`, run again,
save the modified local artifact separately. Preserve both console captures.
Software evidence: alternating readback values, eight rows, completion marker,
recorded elapsed times. Actual visible LED behavior requires a person.

## Button interrupt, no fabricated press

```python
import time
from fpioa_manager import fm
from Maix import GPIO

fm.register(16, fm.fpioa.GPIOHS2, force=True)
key = GPIO(GPIO.GPIOHS2, GPIO.IN, GPIO.PULL_UP)
presses = 0

def on_key(pin):
    global presses
    presses += 1

key.irq(on_key, GPIO.IRQ_FALLING, GPIO.WAKEUP_NOT_SUPPORT, 7)
print("NODU_KEY_ARMED")
try:
    for step in range(10):
        print("NODU_KEY value=%d interrupts=%d" % (key.value(), presses))
        time.sleep_ms(500)
finally:
    key.disirq()
    fm.unregister(16)
print("NODU_KEY_DONE")
```

## Threshold editor and custom camera script

Start a live camera through UI, capture a real JPEG, stop/pause as needed.
Open Tools → machine vision → threshold editor. Record current six-value LAB
tuple from `[aria-label="可复制的阈值 Python 元组"]`, screenshot and frozen JPEG.
Set sliders explicitly to `(20, 80, -70, -10, -10, 40)` using the six labeled
controls, toggle mask, use “复制参数”, and record actual resulting tuple/copy
feedback. This is a chosen green range, not a claim about the scene's colors.
Copy the actual displayed tuple into the `THRESHOLD` line below; capture the
exact script. If UI tuple/copy fails, record it and use the literal default
below for an independent camera-code test; do not claim successful UI copy.

```python
import sensor
import time

namespace = {"__name__": "gc2145_board"}
exec(open("/flash/gc2145_board.py").read(), namespace)
namespace["init_camera"]()
sensor.skip_frames(time=1000)
THRESHOLD = (20, 80, -70, -10, -10, 40)
MIN_PIXELS = 120
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
```

Run first version to completion. Edit only `MIN_PIXELS = 120` to
`MIN_PIXELS = 240`, then rerun; retain both source and output captures.
Blob counts are observations, not detection-accuracy evidence without a
known target. Existing board helper is a prerequisite; do not describe
this as succeeding on a clean factory board.

With camera running, exercise framebuffer disable (wait at least 3 s) and
enable, recording frame sequence/time before/after. Switch histogram modes
rgb/gray/lab/yuv and capture each UI once. Record ~5 s to a unique local
`.bin`, preserve recording result (frame count/bytes/path), then stop.
Use a new camera run if the finite loop ends before these operations finish.
Do not rerun firmware or back up the chip.

## Error feedback

New editor source for syntax error:

```python
print("NODU_SYNTAX_START")
for i in range(3)
    print(i)
```

Then replace with:

```python
print("NODU_RUNTIME_START")
print(1 / 0)
```

Capture traceback and editor selection/decorations for each. An error log
alone is not evidence that the editor highlights or navigates to its line.

## File transfer and boot.py

1. Stop code. Read `/flash/boot.py` and `/sd/boot.py` absence/presence through
   device files before writing; S0 lists neither. If either now exists and
   was not created by this test, STOP this write step and report.
2. Reopen modified finite camera source in editor. Tools → save open script
   as boot.py → “保留原样” → confirm. Capture confirmation text. The board
   has an SD card: FILE_SAVE uses default storage, normally `/sd/boot.py`,
   so check both roots. Capture exact board bytes using read-only service
   calls while UI owns the connection; do not open a second serial session.
3. Reset through Nodu UI and capture new logs/states/frames until idle or
   a bounded 60 s timeout. Autorun requires evidence from this reset, not
   earlier manual-run logs. A reset/reconnect is not a physical power cycle.
4. Remove only the boot.py created by this test after readback matches the
   captured source. Use UI REPL `import uos; uos.remove("<exact path>")`.
   If bytes differ unexpectedly, preserve them and report instead of delete.
5. Use Tools → send file for local `nodu-student-20261020.txt` containing
   exactly `Nodu student file roundtrip 20261020\n`. Check neither root has
   that name first. Capture confirmation, send, read back exact bytes.
   Delete only the matching test file, via UI REPL.
6. `print(1 + 1)` via REPL should produce `2`; browse device files and
   capture them. Stop/disconnect through UI. Reopen raw REPL only after
   successful UI disconnect and execute `inventory-board.py` unchanged;
   save returned stdout to `final-inventory.txt`, then disconnect/close.
   Do not run the comparison or decide integrity status; lead does that.

Leave the browser/backend alive and provide CDP endpoint. No commit and
no product modifications. Physical key press, LCD/LED observation and
power cycle remain explicitly pending.
