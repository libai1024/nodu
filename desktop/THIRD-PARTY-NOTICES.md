# Third-party components

The SCOPE extension, starter project and application composition authored in this workspace use the repository's MIT license. Dependencies remain under their own licenses. This notice is an inventory of the direct foundations and bundled font assets; it does not replace their complete license texts or a release-time dependency inventory.

| Component | Use | License / upstream |
| --- | --- | --- |
| Eclipse Theia | Desktop/browser application framework, shell, Monaco integration, file system, terminal and related packages | [EPL-2.0](https://github.com/eclipse-theia/theia/blob/v1.76.0/LICENSE-EPL), with the stated [secondary GPL-2.0-only + Classpath exception](https://github.com/eclipse-theia/theia/blob/v1.76.0/LICENSE-GPL-2.0-ONLY-CLASSPATH-EXCEPTION) |
| Electron | Desktop runtime | [MIT; runtime includes additional third-party notices](https://github.com/electron/electron/blob/main/LICENSE) |
| Monaco Editor | Code editor, distributed through Theia | [MIT](https://github.com/microsoft/monaco-editor/blob/main/LICENSE.txt) |
| React | Custom SCOPE views, through Theia's shared React module | [MIT](https://github.com/facebook/react/blob/main/LICENSE) |
| color-convert 2.0.1 / color-name 1.1.4 | Retained approximate CIELAB implementation and its regression tests; the 0.1.3 image tools use the Rust/WASM lookup tables described below | MIT; copies in `scope-extension/resources/licenses/color-convert-LICENSE.txt` and `color-name-LICENSE.txt` |
| IBM Plex Sans / IBM Plex Mono | Locally bundled interface and code fonts | [SIL Open Font License 1.1](https://github.com/IBM/plex/blob/master/LICENSE.txt); copy in `scope-extension/style/fonts/FONT-LICENSE.txt` |

The font files are reused from this workspace's design preview and are not fetched at application runtime. The 0.1.3 native protocol and imaging implementations reference the pinned MIT OpenMV plugin and MaixPy firmware sources listed below. Imported numerical tables retain their source notices; GPL qcustomplot and the later restricted OpenMV branches are not used. The example Python files refer to MaixPy-v1 APIs; they do not bundle MaixPy firmware.

Before distributing installers, preserve Electron's bundled license files and generate the complete dependency notice from the exact lockfile and packaged dependency graph. Windows and macOS binaries can contain different native dependencies. Upstream trademarks and project names identify those dependencies, not an endorsement of SCOPE.

## Nodu device service

The Python worker uses the installed **mpremote 1.25.0** transport library (MicroPython, MIT) and **pySerial 3.5** (BSD-3-Clause). The adapter keeps a persistent serial owner, disables automatic soft reset, and adapts the raw-REPL handshake for K210. `requirements.txt` pins these direct versions. `npm run setup:device` installs one per-user environment shared by projects. The older development fallback environment contains mpremote 1.29.0; it is recorded separately rather than described as the pinned environment.

Firmware operations use **kflash 1.1.6** (MIT package declaration) and its pyelftools dependency. The ISP stub's separate provenance remains a release-time review item; this development build is not a distribution license clearance for every embedded payload. License texts supplied by the installed packages are retained in `scope-extension/resources/licenses/`.

The fixed MaixPy-v1 firmware protocol source is `d8901fd2272f000226f1c1037c1eb7c412b88e66`; its `ide_dbg.c` and `ide_dbg.h` have MIT file headers. The retained 0.1.2 Python implementation uses raw REPL camera capture as a migration reference. The 0.1.3 Rust sidecar now implements the IDE protocol and framebuffer path. The complete Sipeed-modified MaixPy IDE 0.2.5 desktop source and its full license inventory have not been located; private connection parameters are recorded separately as observed binary behaviour.

`nodu-imaging` imports RGB quantization, LAB/YUV lookup tables and AprilTag family data from the pinned 2020 OpenMV plugin. Their paths, sizes and checksums are recorded in `native/crates/nodu-imaging/data/README.md` and `../tools/refs/import-imaging.py`. The browser uses this crate through wasm-bindgen (MIT / Apache-2.0), built from the exact versions in `native/Cargo.lock`. Lookup results describe decoded image pixels, which can differ from sensor pixels before JPEG compression.

Fixed sources, per-file license evidence and mode side effects are recorded in [device-reuse.md](../docs/device-reuse.md); image hashes, write ranges and recovery boundaries are recorded in [device-flash-plan.md](../docs/device-flash-plan.md). Firmware, actual device tests and UI acceptance are documented separately from those source studies.

## Bundled FFmpeg media tools

`npm run build:media` builds ffmpeg/ffprobe/ffplay from the pinned official source `ffmpeg-9.0.2.tar.xz` (SHA256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`, `https://ffmpeg.org/releases/`) with an LGPL-only configuration (`--disable-gpl --disable-nonfree --disable-version3 --disable-autodetect --disable-network`, verified against `-buildconf` output). ffplay dynamically links the bundled `libSDL2-2.0.0.dylib`, built from the pinned upstream release `SDL2-2.32.10.tar.gz` (SHA256 `5f5993c530f084535c65a6879e9b26ad441169b3e25d789d83287040a9ca5165`, `https://github.com/libsdl-org/SDL/releases/`, zlib license) into a private prefix inside the media cache — no Homebrew SDL is used. The staged binaries live in `scope-extension/resources/bin/darwin-<arch>/` next to the device service. FFmpeg 9.0.2 is LGPL-2.1-or-later in this configuration: the build uses dynamic linking for its bundled dylib dependency, and `scope-extension/resources/licenses/ffmpeg/` carries the LGPL-2.1 license text, the SDL2 license text, both exact source tarballs, the build recipe (`build-media.cjs` + `BUILD-RECIPE.txt`), and build metadata — included for review; whether the corresponding-source obligation is fully satisfied remains a release-time review item. All staged files are built with a 15.0 deployment target and gate on `minos <= 15.0`; runtime behaviour on macOS 15 is not yet machine-verified. Only the macOS host build exists; Windows/Linux packaging is not implemented. Binaries are ad-hoc signed for local use — release signing, notarization and a complete license clearance remain release-time work, and this inventory is not legal approval. Evidence: `docs/0.1.3/evidence/media-bundle.md`.

## Reference sources for the 0.1.3 rewrite

The Rust device service (`desktop/native/`) is rewritten with reference to the pinned, read-only sources listed in `docs/0.1.3/references.md`. Files that port or adapt code carry `// Ported from <repo>@<commit>:<path> (<license>)` headers.

| Source | Pinned commit | License |
| --- | --- | --- |
| openmv/qt-creator — `src/plugins/openmv` only | `af179e44cddf396a5ab618792d71e9de5cc67032` | MIT (plugin, text below); `tools/tag*.c` BSD-2 (University of Michigan, text below). `qcustomplot` is GPL-3.0 and is NOT ported; `openmv-qtc-14.0.2`/`20.0.2` and newer branches carry a non-commercial clause and are NOT used |
| sipeed/MaixPy-v1 | `d8901fd2272f000226f1c1037c1eb7c412b88e66` | MIT / Apache-2.0 (texts below) |
| sipeed/kflash.py | `550828c768b16ef329695d3f5eace3f6bcf14af2` | MIT — same license text as the kflash 1.1.6 package referenced above; not duplicated |
| sipeed/MaixPy-v1_scripts | `8d7c5f98ba654d226f433d31718d852674cab08d` | MIT (text below); `*.py` examples vendored into `desktop/scope-extension/resources/nodu-resources/examples/` with provenance in `examples/manifest.json` (regenerate via `npm run vendor:examples`) |
| micropython/mpremote | `1.25.0` (installed pip package `~/.nodu/python`, not a nodu-refs clone) | MIT — MicroPython; local implementation reused, text shipped with the package |
| MaixPy_Doc_Zh_Cn_Backup | `2734af3bcf182e3359cde4ed5a3a5d7d9b75aaf1` | No LICENSE file — reference only, no content copied |

`scope-extension/src/common/nodu-board-data.ts` 的引脚别名数值转录自上述 MIT 许可的
MaixPy-v1_scripts 配置脚本（`config_maix_*.py`）；野火连接器触点表转录自
`doc.embedfire.com` 公开引脚图（仅事实数值，无复制图片）。两者均为逐条事实转录，
不含上游代码或文本。

### OpenMV plugin (MIT), (C) 2016 OpenMV, LLC

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### AprilTag tag families (BSD-2), (C) 2013-2016 The Regents of The University of Michigan

```
This software was developed in the APRIL Robotics Lab under the direction of Edwin Olson, ebolson@umich.edu. This software may be available under alternative licensing terms; contact the address above.

An unlimited license is granted to use, adapt, modify, or embed the 2D barcodes into any medium.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The views and conclusions contained in the software and documentation are those of the authors and should not be interpreted as representing official policies, either expressed or implied, of the Regents of The University of Michigan.
```

### MaixPy-v1 (MIT / Apache-2.0), (C) 2019 Sipeed Co.,Ltd.

Repository license: all source code released under MIT or Apache-2.0; Sipeed-created/modified sources are Apache-2.0 ("Copyright 2019 Sipeed Co.,Ltd."), MicroPython/openmv-derived sources are MIT ("Copyright (c) 2013, 2014 Damien P. George").

Apache-2.0 full text: https://www.apache.org/licenses/LICENSE-2.0.txt

MIT text (MicroPython portion):

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### MaixPy-v1_scripts (MIT), (C) 2019 sipeed

Same MIT license text as the MicroPython portion above.

### OpenMV CMSIS-NN network models (MIT), (C) 2016 OpenMV, LLC

`scope-extension/resources/models/` stages five pre-trained `.network` weight files
(cifar10, cifar10_fast, lenet, smile, chars74k) from the pinned upstream revisions
recorded in `resources/models/manifest.json` (repositories `openmv/openmv` and
`kwagyeman/openmv`, fetched as exact `raw.githubusercontent.com` URLs, each verified
against the manifest's byte size and SHA256). These are OpenMV CMSIS-NN model files;
they do not execute on K210 hardware and are provided for the model library's
save-to-disk / copy-to-device workflows only. The upstream root `LICENSE` files at the
pinned revisions (MIT) are staged in `resources/licenses/network-models/`. MIT text:

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
