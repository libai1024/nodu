# Network model library

Scope: `scope.network-library` quick pick over five bundled OpenMV CMSIS-NN
`.network` weight files; actions 保存到本地… / 复制到设备默认存储…, both gated by
the warning `OpenMV CMSIS-NN 格式，不能在 K210 上执行。`

## Provenance

`tools/refs/network-models.json` is the authoritative frozen manifest
(lead-authored; installed-app byte comparison was done upstream and is **not**
recomputed here). `desktop/scripts/fetch-models.cjs` fetched each file from
its exact `https://raw.githubusercontent.com/{repository}/{revision}/{path}`
URL (≤2 MiB bound), verified byte size + SHA256, and staged under
`resources/models/<id>/<basename>`:

| id | repo@rev | file | bytes | sha256 (prefix) |
|---|---|---|---|---|
| cifar10 | openmv/openmv@c372ebe | cifar10.network | 89970 | 1ba1f96b… |
| cifar10_fast | openmv/openmv@c372ebe | cifar10_fast.network | 33602 | 19d94521… |
| lenet | openmv/openmv@c372ebe | lenet.network | 106984 | eeda5f74… |
| smile | openmv/openmv@c372ebe | smile.network | 23882 | 6dad6fc6… |
| chars74k | kwagyeman/openmv@a97e4dc | fnt-chars74k.network | 93799 | 63af22e7… |

Root `LICENSE` files at the same pinned revisions are staged in
`resources/licenses/network-models/{openmv,kwagyeman}-LICENSE.txt` (both MIT).
No other OpenMV code was copied.

## Runtime

`desktop/scripts/build-models.cjs` regenerates `resources/models/model-data.js`
+ `.d.ts` from the **committed** staged files — it performs no network access;
the extension imports the embedded base64 at runtime fully offline. The
manifest itself is copied to `resources/models/manifest.json`.

Device copy is the original IDE's mounted-disk workflow (`saveFile` to default
storage, `overwrite: false` local saves, explicit overwrite confirm for
device). There is deliberately **no run/load button**: these are CMSIS-NN
weights for OpenMV ARM targets and cannot execute on the K210's KPU.

## Verified

- All five fetches: size + SHA256 matched the manifest (script output).
- `model-data.js` regenerated offline; extension compile resolves the typed
  import via `model-data.d.ts`.
- `npm run compile`: clean.
- Live on runtime 4195: `CNN 模型库` quick pick lists all five models with
  `name · bytes · MIT · repo` detail; model selection shows the
  `保存到本地… / 复制到设备默认存储…` action pick; choosing an action raises the
  `不能在 K210 上执行` warning before proceeding.

## Not verified in this pass

- The native save dialog itself (cannot be driven via CDP); device copy is
  exercised only via the shared `saveFile` machinery already covered by
  backend-validation's mock write.
