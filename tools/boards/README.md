# Board models

`build_embedfire.py` builds an illustrative 野火 K210 CAM model in Blender
(headless) and renders two transparent PNG views used by the app's
"认识开发板" page.

## Run

```
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/boards/build_embedfire.py
# or with explicit output directories:
... --python tools/boards/build_embedfire.py -- --out <model-dir> --renders <png-dir>
```

## Outputs

| Path | Contents |
| --- | --- |
| `models/embedfire-cam.blend` | Editable scene: named objects (`pcb`, `processor`, `camera`, `sd`, `usb`, `header-1`, `header-2`, `lcd-socket`, `fpc`, `button-*`) in one `embedfire-cam` collection |
| `models/embedfire-cam.glb` | Same scene exported as glTF binary |
| `desktop/scope-extension/resources/boards/embedfire-cam-{top,angled}.png` | 960×720 RGBA renders loaded as esbuild data URLs |

## Fidelity limits

The layout follows the vendor reference photo
(`doc.embedfire.com .../_images/pin.png`, not redistributed): processor
upper-left, camera module upper-middle with flex ribbon, microSD top-right,
USB on the right edge, 2×14 and 2×3 headers along the bottom, two top-edge
buttons, four mounting holes. Relative sizes and positions are illustrative —
**not mechanical CAD**. No dimensions, PCB revision, or per-contact pin-1
orientation is verified; the model deliberately does not number individual
header holes. Wiring must be checked against the official pin table and the
silkscreen on the physical board.

Pin facts used by the app come from `desktop/scope-extension/src/common/nodu-board-data.ts`
and `docs/0.1.3/evidence/board-source-audit.md`, not from this model.
