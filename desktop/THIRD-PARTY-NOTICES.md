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

The fixed MaixPy-v1 firmware protocol source is `d8901fd2272f000226f1c1037c1eb7c412b88e66`; its `ide_dbg.c` and `ide_dbg.h` have MIT file headers. The current preview uses ordinary sensor JPEG capture over the same serialized raw REPL, without entering IDE mode or copying Qt plugin code. The complete MaixPy IDE 0.2.5 desktop source and its full license inventory have not been located. Restricted OpenMV Qt protocol/threshold/keypoint plugin files are not copied or translated into this project.

Fixed sources, per-file license evidence and mode side effects are recorded in [device-reuse.md](../docs/device-reuse.md); image hashes, write ranges and recovery boundaries are recorded in [device-flash-plan.md](../docs/device-flash-plan.md). Firmware, actual device tests and UI acceptance are documented separately from those source studies.
