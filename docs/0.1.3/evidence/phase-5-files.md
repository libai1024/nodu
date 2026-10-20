# 证据：板端文件工作流 + Traceback 行定位（phase 5）

日期：2026-10-20。范围：脚本格式化、确认式板端写入、文件菜单、stderr traceback 行定位、media 打包守护修正。无硬件测试。

## 实现

- **`nodu-device/src/script.rs`（新，`pub mod script`）**：`format(code, strip_comments, spaces_to_tabs) -> Result<String,String>`。UTF-8 字节态扫描器，256 KiB 上限；`#` 只在字符串外删除注释且保留换行（行号不漂移）；单/双/三引号与转义安全；`spaces_to_tabs` 只转换代码行前导缩进（4 空格→`\t`），混入制表符缩进或非 4 倍数空格缩进即报错（不落回乱改）；字符串/行内空白不动。区别于 openmvplugin.cpp 旧 `loadFilter`（行 6538+）的正则替换——本实现不会破坏多行字符串/行内 `x*4` 等。
- **formatScript RPC**：protocol `METHODS` + `FormatScript` 分发（无需连接设备）；服务端 `formatScript(code, stripComments, spacesToTabs)` 校验 code 后透传；facade 白名单 `saveFile`, `formatScript`。
- **确认式写入**：`writeFile(path,data,overwrite,confirmedStartup)` 全链路；服务端 `validatePath` 第三参仅 `===true` 放行 `boot.py/main.py`（仍拒绝穿越/控制字符，错误文案含「保护」）；Rust `do_write_file` 先 `remote_path` 归一化，再要求 `/flash/`·`/sd/` 前缀，启动文件缺确认/非布尔即拒（写之前）。**读回校验**：临时文件写入后 `do_read_file` 取回 → `Sha256` 比对 → 不匹配则报 checksum 错误且不 `os.rename`，原文件不动；`nodu-mockboard` 加 `set_corrupt_writes` 注入破坏。
- **`nodu-file-tools.tsx`（新 contribution）**：`scope.save-boot-script`/`scope.send-file` 挂 见微 菜单；connected+files+非忙 才可用。保存 boot：捕获当前编辑器缓冲（含未保存）→ 格式化选择（保留原样默认）→ ConfirmDialog（文件名+字节数+「覆盖默认存储 /sd」+「下次开机执行」）→ 版本未变才写；`device.saveFile('boot.py', data, true)`；缓冲不改不存。发送文件：原生选择器（2 MiB readFile 上限）→ basename → ConfirmDialog（默认存储+覆盖提示，启动文件加注启动警告）→ `saveFile(name, data, startup)`。`model.saveFile` 返回 `Promise<boolean|undefined>`，成功才提示。
- **面板写传输**：`nodu-device-panel` 写入流程在选定文件后按目标 basename 命中启动文件即弹「写入启动文件」确认（确切入参 `confirmedStartup=true`），取消即不发 RPC；overwrite 复选框语义不变。
- **Traceback 定位**：`runCurrentEditor` 运行前捕获 `{widget,control,model,version,path}`；`onDidLog` 只处理 stderr 流，16 KiB 滚动尾部匹配 `File "...", line N`；仅 `<stdin>` 或等于捕获路径/同 basename 的帧映射到该编辑器；widget/model 已释放或版本变更则跳过；`revealLineInCenter` + 光标置行首 + 整行 `nodu-traceback-line` 装饰（`color-mix(in srgb, var(--theia-errorForeground) 15%, transparent)`），新一轮运行/dispose 前清除。不会为板端内部路径自动开文件。
- **build-media 守护修正**：fetch `AbortSignal.timeout(120000)` + 重定向 body abort；tar 全量条目顶层校验；`-L` 断言 LGPL 文案（容忍折行）；构建 marker 纳入 SHA/arch/目标版本/SDL receipt（sdl2-compat 2.32.72 / sdl3 3.4.16），不一致强制 `make clean` 重配重编；`MACOSX_DEPLOYMENT_TARGET=15.0`；`vtool` 记录全部暂存件 minos，超 15 的 SDL 记 `minOsBlocker`；licenses 目录现含 `build-media.cjs` 本体。
- **build-native 修正**：staged 二进制改经临时文件 rename 落位——原 `copyFileSync` 原地覆盖会让 macOS provenance 记录失配，内核 SIGKILL 后续 exec/mmap（实测 `cmp`/执行均被 "Taskgated Invalid Signature" 杀）。

## 验证（实际执行）

- Rust：`cargo test -p nodu-device --all-features` → lib 15/15（script.rs 内联注释/引号内 `#`/转义/三引号跨行/Unicode/EOF 注释/CRLF/4·8 空格转换/字符串四空格不动/混缩进拒绝/双 false 恒等 等 15 项）+ mock_integration 27/27（含 startup 缺确认被拒、checksum 失败原文件完整、空文件写、大 CJK 输出、相机起停恢复）。`cargo clippy -p nodu-device --all-features -D warnings` 0 告警；`cargo fmt --check`（device/protocol/mockboard）通过。
- Node：`node --test scope-extension/test/backend-validation.cjs` → 16/16（新增：formatScript/confirmedStartup 前置校验；mock e2e 增 boot.py 显式确认写入+读回 `print(1)`、formatScript 往返 `x=1 # c\n    y=2` → `x=1 \n\ty=2`）。
- 前端：`npm run compile` 0 错误；`npm run build --workspace @scope/electron-app` 0 错误；`check:licenses` 171 文件 clean。
- UI（4195 实例，`NODU_DEVICE_MOCK=1` 重启，运行时变更已记录）：mock 连接成功；命令面板可见「保存到 boot.py 启动脚本/发送文件到设备…」；格式化三选弹层正常；「写入 boot.py」确认框含文件名/字节数/警告文本（截图 `boot-confirm.png`）；取消后无 RPC/无提示；确认后 toast「已将 camera_preview.py 写入板端 boot.py（默认存储）」。Traceback：mock 运行 `1/0` → stderr `File "<stdin>", line 1` → 行 1 整行高亮 + 光标置 1 行（截图 `traceback-highlight.png`，DOM 断言 `.nodu-traceback-line` 存在）。验证后断开 mock、编辑器内容已还原。
- Media：复跑 `build:media` 全绿——`-version`/`-buildconf`/`-L`（LGPL 断言生效）、无 Homebrew 路径、`ffmpeg/ffprobe/ffplay minos=15.0`、SDL dylibs `minos=26.0` 记 blocker、lavfi→mpeg4→ffprobe→ffplay dummy 冒烟通过（产物 1,146 字节）。

## 截图

- `artifacts/ui-minimal/20261020-files/boot-confirm.png`：写入 boot.py 确认框。
- `artifacts/ui-minimal/20261020-files/traceback-highlight.png`：stderr traceback 命中行 1 整行高亮。

## 限制

- `send-file`/面板写入的原生文件选择框无法由 CDP 驱动，取消路径靠 Rust 侧「确认前拒写」测试覆盖；UI 仅验证了菜单可达性与确认框行为。
- mock 的 traceback 恒为 `line 1`，跨行定位/其它文件名忽略只覆盖到 `<stdin>` 匹配路径；真实板端多帧匹配待硬件回归。
- trace_smoke.py 测试脚本经磁盘注入（文件监视器刷新干净缓冲），验证后已删除并还原 camera_preview.py。

## 评审修正（2026-10-20 第二批次）

- **script.rs 注释词法**：`#` 扫描改为无条件——`strip_comments=false` 时注释内引号不再进入字符串态（曾致 `# unmatched '\n    x=1` 缩进转换失效）；缩进检测把「缩进后首字节为 `#`」的行视为注释行（不参与空格/制表/4 倍数检查，缩进原样保留）；`from_utf8` 失败返回描述性错误而非空串。新增 3 个回归测试（含注释行不干扰混缩进检测）。
- **确认后再校验**：`saveBootScript` 在 ConfirmDialog 返回后再查 `widget.isDisposed`/`control.getModel()!==model`/`model.isDisposed()`/`versionId`；save/send 两处开头捕获 `device.state.port`，确认后复核 `connected&&!busy&&!running&&port===captured`（`deviceUnchanged`）；面板写入在文件选择器前捕获 port、写入前复核。
- **traceback 装饰清理时序**：`runCurrentEditor` 先 `clearTracebackDecoration()`（装饰 id 属旧 run 的 model）再替换 `runTarget`，修掉旧序在新 model 上误清导致旧高亮残留的问题。
- **SDL2 改源码构建**：见 `media-bundle.md`——Homebrew SDL bottle 弃用，SDL2-2.32.10 固定源包构建进缓存私有前缀，全部暂存件 `minos<=15.0` 硬 gate，`libSDL3.dylib` 与 compat/SDL3 许可条目移除。

## 评审修正验证（实际执行）

- `cargo test -p nodu-device --all-features script`：18/18（3 个新回归用例通过）；`clippy -D warnings` 0；`fmt --check` 通过。
- `npm run compile` 0 错误；`npm run build --workspace @scope/electron-app` 0 错误；`check:licenses` clean。
- UI（4195，`NODU_DEVICE_MOCK=1`，验证后已恢复 clean 重启）：A 文件 `1/0` 运行产生整行高亮 → 打开 B 文件运行干净脚本 → 返回 A 后 `.nodu-traceback-line` 计数 0（旧序会残留）；确认框打开时磁盘改写源文件（版本号变化）→ 点「写入 boot.py」提示「编辑器内容已变化，请重试。」零写入；确认框打开时断开设备 → 点「写入 boot.py」提示「设备状态已变化，写入 boot.py已取消；请重试。」零写入。
- `build:media` 全绿：SDL2 源构建安装 → FFmpeg 全量重编 → `minos=15.0`×4 → 版本/许可证/依赖/冒烟全过；`otool -L` 复核 ffplay 仅系统库+`@loader_path/libSDL2-2.0.0.dylib`。
