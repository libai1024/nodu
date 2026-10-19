# Third-party components

The SCOPE extension, starter project and application composition authored in this workspace use the repository's MIT license. Dependencies remain under their own licenses. This notice is an inventory of the direct foundations and bundled font assets; it does not replace their complete license texts or a release-time dependency inventory.

| Component | Use | License / upstream |
| --- | --- | --- |
| Eclipse Theia | Desktop/browser application framework, shell, Monaco integration, file system, terminal and related packages | [EPL-2.0](https://github.com/eclipse-theia/theia/blob/v1.76.0/LICENSE-EPL), with the stated [secondary GPL-2.0-only + Classpath exception](https://github.com/eclipse-theia/theia/blob/v1.76.0/LICENSE-GPL-2.0-ONLY-CLASSPATH-EXCEPTION) |
| Electron | Desktop runtime | [MIT; runtime includes additional third-party notices](https://github.com/electron/electron/blob/main/LICENSE) |
| Monaco Editor | Code editor, distributed through Theia | [MIT](https://github.com/microsoft/monaco-editor/blob/main/LICENSE.txt) |
| React | Custom SCOPE views, through Theia's shared React module | [MIT](https://github.com/facebook/react/blob/main/LICENSE) |
| color-convert 2.0.1 / color-name 1.1.4 | Browser RGB-to-LAB conversion for real JPEG frame inspection; PC sRGB approximation, separate from board RGB565 algorithms | MIT; copies in `scope-extension/resources/licenses/color-convert-LICENSE.txt` and `color-name-LICENSE.txt` |
| IBM Plex Sans / IBM Plex Mono | Locally bundled interface and code fonts | [SIL Open Font License 1.1](https://github.com/IBM/plex/blob/master/LICENSE.txt); copy in `scope-extension/style/fonts/FONT-LICENSE.txt` |

The font files are reused from this workspace's design preview and are not fetched at application runtime. No Arduino IDE, MaixPy IDE or OpenMV IDE application source is copied into the SCOPE extension. The example Python files were authored for this workspace and refer to MaixPy-v1 APIs; they do not bundle MaixPy firmware.

Before distributing installers, preserve Electron's bundled license files and generate the complete dependency notice from the exact lockfile and packaged dependency graph. Windows and macOS binaries can contain different native dependencies. Upstream trademarks and project names identify those dependencies, not an endorsement of SCOPE.

## Nodu device service

The Python worker uses the installed **mpremote 1.25.0** transport library (MicroPython, MIT) and **pySerial 3.5** (BSD-3-Clause). The adapter keeps a persistent serial owner, disables automatic soft reset, and adapts the raw-REPL handshake for K210. `requirements.txt` pins these direct versions. `npm run setup:device` installs one per-user environment shared by projects. The older development fallback environment contains mpremote 1.29.0; it is recorded separately rather than described as the pinned environment.

Firmware operations use **kflash 1.1.6** (MIT package declaration) and its pyelftools dependency. The ISP stub's separate provenance remains a release-time review item; this development build is not a distribution license clearance for every embedded payload. License texts supplied by the installed packages are retained in `scope-extension/resources/licenses/`.

The fixed MaixPy-v1 firmware protocol source is `d8901fd2272f000226f1c1037c1eb7c412b88e66`; its `ide_dbg.c` and `ide_dbg.h` have MIT file headers. The 0.1.2 Python implementation's camera preview uses ordinary sensor JPEG capture over the serialized raw REPL, without entering IDE mode or copying Qt plugin code. The Phase 1 Rust sidecar (`desktop/native/`) implements no camera/framebuffer path yet (`capabilities.framebuffer` is false). The complete MaixPy IDE 0.2.5 desktop source and its full license inventory have not been located. Restricted OpenMV Qt protocol/threshold/keypoint plugin files are not copied or translated into this project.

Fixed sources, per-file license evidence and mode side effects are recorded in [device-reuse.md](../docs/device-reuse.md); image hashes, write ranges and recovery boundaries are recorded in [device-flash-plan.md](../docs/device-flash-plan.md). Firmware, actual device tests and UI acceptance are documented separately from those source studies.

## Reference sources for the 0.1.3 rewrite

The Rust device service (`desktop/native/`) is rewritten with reference to the pinned, read-only sources listed in `docs/0.1.3/references.md`. Files that port or adapt code carry `// Ported from <repo>@<commit>:<path> (<license>)` headers.

| Source | Pinned commit | License |
| --- | --- | --- |
| openmv/qt-creator — `src/plugins/openmv` only | `af179e44cddf396a5ab618792d71e9de5cc67032` | MIT (plugin, text below); `tools/tag*.c` BSD-2 (University of Michigan, text below). `qcustomplot` is GPL-3.0 and is NOT ported; `openmv-qtc-14.0.2`/`20.0.2` and newer branches carry a non-commercial clause and are NOT used |
| sipeed/MaixPy-v1 | `d8901fd2272f000226f1c1037c1eb7c412b88e66` | MIT / Apache-2.0 (texts below) |
| sipeed/kflash.py | `550828c768b16ef329695d3f5eace3f6bcf14af2` | MIT — same license text as the kflash 1.1.6 package referenced above; not duplicated |
| sipeed/MaixPy-v1_scripts | `8d7c5f98ba654d226f433d31718d852674cab08d` | MIT (text below) |
| micropython/mpremote | `1.25.0` (installed pip package `~/.nodu/python`, not a nodu-refs clone) | MIT — MicroPython; local implementation reused, text shipped with the package |
| MaixPy_Doc_Zh_Cn_Backup | `2734af3bcf182e3359cde4ed5a3a5d7d9b75aaf1` | No LICENSE file — reference only, no content copied |

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
