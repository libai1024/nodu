# Same-board comparison recipe

Perform only after Nodu releases `/dev/cu.usbserial-3110`. Original app:
`/Applications/MaixPy IDE.app` version 0.2.5. Never two serial owners.
Do not change product code or the original application's code/settings files.

Use macOS Accessibility (System Events / AX) for the original app, not a
protocol substitute. Known AX labels from the captured original window:

- toolbar buttons `连接`, `开始(运行脚本)`; run shortcut ⌘R
- framebuffer checkbox `禁用` with tooltip
  `禁用帧缓冲区以获得最佳性能`
- histogram popup `RGB色彩空间`, options RGB/灰度/LAB/YUV色彩空间
- terminal checkbox description `串行终端`
- tools menu `选择开发板`, reset choice Sipeed Maix Dock (same reset index 2)

Capture native menu/window AX labels, exact prompts and original screenshots.
Screenshot only the app window where possible. Do not assume screen positions
from a previous window: get current AX element bounds before clicking.

## Common source, same bytes in each IDE

Create local `comparison-camera.py` from this exact source:

```python
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
```

This is a same-input comparison, not an unmodified official example or clean
board prerequisite test. The helper is already in the S0 baseline.

## Comparison sequence

1. Original UI connects to `-3110` with Maix Dock reset choice. Capture
   connection status, firmware, terminal, and any prompts/errors.
2. Open common source via File → Open, run. Capture real framebuffer and
   status-bar FPS/terminal after 5–10 s. Stop if camera errors; record exact
   failure instead of repeatedly reconnecting without new evidence.
3. Disable framebuffer, wait at least 3 s, re-enable, capture pause/resume.
   If only screenshots/visual status available, do not invent frame counters.
4. Switch all four histogram color spaces and capture labels/statistics.
   Sequential moving-camera frames cannot prove numeric equality between IDEs.
5. Stop, capture prompt/state; run `print(1 + 1)` as a new temporary editor
   document and capture `2`.
6. If boot/file workflows are reachable, use an original-only finite source:
   `print("NODU_ORIGINAL_BOOT_CHECK")\n` and a unique local text file named
   `nodu-original-20261020.txt` with bytes
   `Nodu original file roundtrip 20261020\n`. Capture exact confirmations
   and choose unchanged formatting. Check both /flash and /sd after original
   disconnect via a single raw sidecar session. Restore/delete only these
   newly created, content-matching files; never touch user startup files.
   Do not write when either boot.py already exists unexpectedly.
7. Open original threshold editor on a captured frame, record six-value
   LAB tuple and controls. No numerical parity claim without feeding the
   same frozen image to both programs.
8. Disconnect original, capture soft-reset/port-release observations, close
   it before Nodu reconnects. Reuse Nodu browser/backend and repeat steps
   1–5 with the same common source, capturing equivalent screenshots.
9. After cleanup, UI disconnects, run lead's `inventory-board.py` unchanged
   over raw REPL and save `post-comparison-inventory.txt`, then disconnect.

Do not mark the physical power-cycle comparison complete; that needs the
user to unplug/replug. Report incomplete steps explicitly. Leave existing
Nodu backend/browser running, original app disconnected, board released.

## Electron native checks independent of serial

Reuse already running Electron if it is the current build; otherwise use the
project's ordinary launcher on its own backend port, disconnected. Check:

- file/edit/tools/window/help are Chinese native menus
- ⌘N opens the Nodu template in an actual editor
- editing and closing triggers a Chinese save/discard dialog
- window menu Minimize/Zoom/Fullscreen and ⌘M work, restoring the window after
  each operation
- no serial connect/flash operation in Electron during another app's session

Capture actual screenshots/AX and action results, not just command registration.
No product changes, commits, or acceptance.csv edits in this execution batch.
