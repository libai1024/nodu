# Nodu 0.1.4 实施计划 — 补齐 MaixPy IDE 0.2.5 剩余功能并完成原版对照

日期：2026-10-20。状态：**计划已确认，开发中**。基线：0.1.3（`7da83fe`），
复刻原则不变：功能与原版 MaixPy IDE 0.2.5 一致，参考原版源码重写，
不照抄 Qt 代码；界面保留 Theia 现代 IDE 结构。

交付目标：功能和原版逐项一致、UI 具备现代 IDE 特点的 Nodu IDE。
本版只处理 0.1.3 验收表中下列未完成项：A6.1、A6.2、G3.1、I1.1、I1.2、
I3.1、U1.1、N1.6。媒体打包和 Windows（N1.7、X1.1、X1.2）仍按
[0.1.3 遗留事项](../0.1.3/remaining-work.md) 单独排期，不在本版范围。

## 0. 已确认的决定（2026-10-20）

| 决定 | 内容 |
| --- | --- |
| 更新源 | 流程照原版完整实现，地址写在偏好设置里，**默认关闭**；有 Nodu 发布源后再打开 |
| 示例库 | 内置完整 `MaixPy-v1_scripts@8d7c5f98`（MIT），按原版目录分类显示；保留“更多示例”链接 |
| 菜单 | 保留 Theia 菜单结构，**补齐原版独有项**；macOS 自动注入项（听写、表情、自动填充）不计 |
| 原版对照 | 用户操作原版 IDE，Nodu 侧抓取板端状态和截图，再在 Nodu 上跑同样步骤对比 |

## 1. 调查结论（决定实现方式的事实）

- **原版更新链路已失效**：`dl.sipeed.com/MAIX/MaixPy/ide/maixpy_ide_version.txt`
  返回 `0.2.3`（低于 0.2.5，原版不会提示）；资源版本返回 `0.1.0`，
  资源包 `maixpy_ide_resources_0.1.0.zip` 返回 404。所以 Nodu 不对接 Sipeed，
  只复刻流程。
- **原版流程**（`openmv/qt-creator@af179e4` `openmvplugin.cpp`）：
  - 启动时若带 `-update_resources`，或已记录资源版本低于 IDE 版本：资源版本
    清零 → 删除用户资源目录 → 从安装包复制 `examples/firmware/html/models`
    → 写入 IDE 版本号（约 150–200 行）。
  - 版本检查：GET 版本文本，按 `^(\d+)\.(\d+)\.(\d+)$` 解析，比当前新就弹
    “Update Available / 下载”，按下载打开发布页（约 1960–2012 行）。
  - 资源更新：GET 资源版本，比已记录版本新就弹“安装 / 取消” → 带进度和取消的
    下载 → 资源版本清零 → 删用户资源目录 → 解压 → 写新版本 → “安装成功，
    请重启” → 退出（`packageUpdate()`，约 2906–3062 行）。
- **原版示例**：0.2.5 安装包只带 `examples/01-Basics/helloworld.py` 一个文件，
  “更多示例”打开 `https://github.com/sipeed/MaixPy_scripts`。
  `MaixPy-v1_scripts@8d7c5f98` 有 160 个 `.py`（深度 1–4 层），仓库 38 MB，
  大文件是 kmodel、wav、mp4、zip、pdf。
- **原版菜单**：[maixpy-ide-0.2.5-menus.txt](../0.1.3/evidence/maixpy-ide-0.2.5-menus.txt)。
  快捷键标注 `[修饰码:键]` 按 macOS 菜单修饰码解读：`0`=⌘、`1`=⇧⌘、
  `8` 位表示不含 ⌘，所以 `9`=⇧、`12`=⌃、`13`=⌃⇧；`24` 是系统注入项。
- **原版主窗口**：[maixpy-ide-0.2.5-main-window.txt](../0.1.3/evidence/maixpy-ide-0.2.5-main-window.txt)。
- 本机已安装 `/Applications/MaixPy IDE.app`（0.2.5），野火 CAM K210 在
  `/dev/cu.usbserial-3120`，N1.6 具备条件。

## 2. 分阶段任务

### 阶段 0 — 版本基线

1. 当前 HEAD 打 `v0.1.3` 标签（需用户确认）。
2. JS 包（`desktop/package.json` 与三个 workspace）和 Rust crate 版本统一为
   `0.1.4`；关于对话框的回退版本常量同步。

### 阶段 1 — 资源与更新（A6.1、A6.2、G3.1）

新 crate `nodu-resources`（库 + 二进制 `nodu-resources`），由 Node 后端按需
拉起，stdout 输出 JSON 行（进度、结果、错误）；不进入设备侧车，避免长下载
阻塞串口请求。新依赖限 `ureq`（rustls）和 `zip`（仅 deflate），须为发布满 7 天
的版本并通过 `cargo-deny`。

子命令：

| 命令 | 行为 |
| --- | --- |
| `check-version --url U --current X.Y.Z` | GET（15 s 超时、≤ 64 B），按原版正则解析，输出 `latest` 和 `newer` |
| `check-resources --url U --installed X.Y.Z` | 同上，对比已记录资源版本 |
| `install --url-template T --version X.Y.Z --dest D [--sha256]` | 下载到 `D` 同级临时文件（进度事件；stdin 关闭或 SIGTERM 即取消并删除临时文件）→ 按需校验 `<zip>.sha256` → 解压到同级暂存目录 → 原子换入 |
| `reset --bundled B --dest D` | 从安装包资源目录复制到暂存目录 → 原子换入 |

安全要求（相对原版的加固，用户可见流程不变）：

- 原版“先删后解压”在失败时会丢资源；Nodu 改为“暂存 → 旧目录改名备份 →
  暂存改名就位 → 删除备份”，任何一步失败都保留旧资源和旧版本号。
- 解压拒绝绝对路径、`..`、符号链接、设备文件；上限 20 000 个条目、解压后
  512 MiB、单文件 64 MiB。
- 只接受 `https://`（测试用 `http://127.0.0.1` 例外）。
- 版本号写入 `~/.nodu/resources-version.json`，资源目录 `~/.nodu/resources/`；
  先换入资源，再写版本号。

偏好设置（Theia preferences，`nodu.update.*`）：

| 键 | 默认 |
| --- | --- |
| `enabled` | `false` |
| `versionUrl` | `""` |
| `downloadPageUrl` | `""` |
| `resourcesVersionUrl` | `""` |
| `resourcesUrlTemplate` | `""`（`%1.%2.%3` 占位，与原版一致） |
| `requireSha256` | `true` |

启动流程（Node 后端启动时，前端只做对话框）：

1. **资源初始化**（与 `enabled` 无关，照原版）：带 `-update_resources`，或已记录
   资源版本低于应用版本 → `reset`，从安装包资源复制。
2. `enabled` 且地址非空时：版本检查 → 有新版本弹“有可用更新：Nodu 新版本
   (x.y.z) 可供下载。”，按钮“下载 / 取消”，下载打开 `downloadPageUrl`。
3. `enabled` 且地址非空时：资源检查 → 弹“有新的 Nodu 资源可用（例如示例、
   固件、文档等）。”，按钮“安装 / 取消” → “正在下载…”进度（可取消）→
   “正在安装…”（不可取消）→ “安装成功！请重启 Nodu。”，Electron 下提供
   “立即重启”（`app.relaunch`），浏览器端只提示。
4. 错误文案照原版：标题“包更新”，“错误：%1！” / “无法打开资源文件
   “%1”！” / “网络请求失败“%1”！”。网络失败只在资源安装流程报错；
   启动时的静默检查失败只写日志，不弹窗（原版同样不弹）。

`-update_resources`：`scripts/launch.cjs` 消费该参数，以环境变量
`NODU_UPDATE_RESOURCES=1` 传给后端，触发第 1 步强制重置；不转发给 Theia。

### 阶段 2 — 内置示例库（I3.1）

1. `scripts/vendor-examples.cjs`：从 `nodu-refs/MaixPy-v1_scripts` 读取，先确认
   HEAD 为 `8d7c5f98ba654d226f433d31718d852674cab08d`，只复制 `.py`
   （单文件 ≤ 256 KiB）和根目录 `LICENSE`、`README.md`，保持原目录结构，
   写出 `manifest.json`（来源仓库、提交、相对路径、字节数、SHA-256）。
2. 输出到安装包资源目录 `desktop/scope-extension/resources/nodu-resources/examples/`：
   顶层是脚本库原分类（`application`、`basic`、`board`、`hardware`、
   `machine_vision`、`modules`、`multimedia`、`network`），另加 `Nodu`
   分类收录 `desktop/examples` 下现有示例。
3. 示例菜单改读用户资源目录 `~/.nodu/resources/examples`（阶段 1 初始化后
   存在；缺失时退回安装包目录）。去掉 48 个、2 层的上限，改为最多 5 层、
   1000 项；目录和文件按名称排序；打开为未保存副本（原版语义，保持不变）。
4. `THIRD-PARTY-NOTICES` 的 MaixPy-v1_scripts 条目注明内置路径和提交；
   `check-licenses` 必须通过。

### 阶段 3 — 菜单逐项补齐（I1.1、I1.2）

保留 Theia 已有项；下表是需要新增或调整的原版项。“已有”表示 Theia 或 0.1.3
已提供，只核对位置和快捷键。

**文件**

| 原版项 | 快捷键 | 实现 |
| --- | --- | --- |
| 新建文件… | ⌘N | 现有 `scope.new-script` 模板，Electron 下绑定 ⌘N（取代 Theia 的空白新文件） |
| 打开文件… | ⌘O | 已有 |
| 文档文件夹 | — | 改为子菜单：列出 `~/Documents/Nodu` 下的 `.py`（递归，规则同示例），空目录时显示禁用项“将一些代码添加到“<路径>””；末尾保留“在访达中打开” |
| 示例 / 更多示例 | — | 阶段 2 |
| 最近的文件 | — | 新子菜单：最近打开的 10 个文件（按用户全局保存），末尾“清除菜单”；文件已不存在时点击给出提示并移除该项 |
| 保存 / 另存为 / 关闭 | ⌘S / ⇧⌘S / ⌘W | 已有 |
| 打印… | 无（见 §3） | 新命令：把当前编辑器文本按等宽字体渲染到隐藏 iframe 后调用系统打印 |

**编辑**

| 原版项 | 快捷键 | 实现 |
| --- | --- | --- |
| 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 | 原版同 | 已有 |
| 从剪贴板历史记录粘贴 | ⇧⌘V | 新：记录本窗口内编辑器的复制/剪切（最近 10 条，去重，不持久化），快速选择后在光标处粘贴 |
| 高级 → 使空格可见 | — | 切换 `editor.renderWhitespace`（`none` ↔ `all`） |
| 高级 → 清除空格 | — | 删除行尾空白（Monaco `editor.action.trimTrailingWhitespace`） |
| 高级 → 启用文本环绕 | — | 切换 `editor.wordWrap` |
| 高级 → 切换注释选择 | ⌘/ | 已有，确认位置 |
| 高级 → 剪切行 | ⇧Del | 剪切当前行（无选区时） |
| 高级 → 复制行 | — | 复制当前行到剪贴板 |
| 高级 → 大写选择 / 小写选择 | ⌃⇧U / ⌃U | Monaco 大小写转换 |
| 高级 → 折叠 / 展开 / 切换折叠全部 | ⌘< / ⌘> / — | Monaco fold / unfold / 全部折叠切换（保留 Theia 原有快捷键） |
| 高级 → 增加 / 减小 / 重置字体大小 | ⌘+ / ⌘- / ⌃0 | 改 `editor.fontSize`，重置回 13 |
| 查找/替换 → 查找/替换 | ⌘F | 已有 |
| 查找/替换 → 打开高级查找 | ⇧⌘F | Theia 工作区搜索 |
| 查找下一个 / 上一个 | ⌘G / ⇧⌘G | 已有，确认菜单项 |
| 替换并查找 / 全部替换 | ⌘= / — | Monaco 替换命令 |
| 转到行… | ⌘L | 新增 ⌘L 绑定（保留 Theia 原有 ⌃G） |

**工具 / 窗口 / 帮助**：0.1.3 已对齐，只做最终核对。

### 阶段 4 — 专业模式布局逐项验收（U1.1）

按主窗口证据逐项核对，并在 N1.6 会话里截取两边同状态截图：

- 工具栏顺序：新建、打开、保存、撤销、重做、剪切、复制、粘贴、连接、
  开始（运行脚本）。
- 帧缓冲区：录制、缩放到合适大小、禁用帧缓冲区。
- 直方图：色彩空间下拉（RGB / 灰度 / LAB / YUV），三个通道各 8 项统计
  （平均数、中位数、众数、StDev、最小、最大、LQ、UQ），无图像时显示“Res - 没有图像”。
- 编辑器：文档下拉、关闭文档（⌘W）、“Line: x, Col: y”。
- 底部：搜索结果、串行终端。
- 状态栏：固件版本（链接）、串行端口、FPS（提示“可能与摄像头帧率不同”）。

差异分三类记录：已对齐、有意保留现代 IDE 形态（写理由）、需修正（修完复验）。

### 阶段 5 — 原版并排对照（N1.6）

用户在原版 IDE 中按清单操作；每步之后由 Nodu 工具读取板端状态
（`/flash` 文件清单与 SHA-256、`ide_mode.conf`、`boot.py`）并保存截图，
然后在 Nodu 上跑同一步骤，记录到 `evidence/side-by-side-<日期>.md`。

| 步骤 | 对比内容 |
| --- | --- |
| 1 连接（板型：Maix Bit 等原版可用项） | 是否成功、所需时间、`ide_mode.conf` 内容 |
| 2 运行 helloworld | 终端输出、帧缓冲是否出图、FPS 范围 |
| 3 禁用 / 启用帧缓冲 | 画面暂停与恢复 |
| 4 直方图切换四种色彩空间 | 统计项和数值量级 |
| 5 停止脚本 | 终端提示、板端状态 |
| 6 保存脚本到 boot.py | 确认文案、板上 `boot.py` 字节对比（去注释、空格转 Tab 规则） |
| 7 发送文件到开发板 | 板上文件字节与 SHA-256 |
| 8 阈值编辑器 | 同一帧的 LAB 阈值结果 |
| 9 断开 | 板端是否软重启、端口释放 |
| 10 断电重连 | 再次进入 IDE 模式的行为 |

原版独占串口，期间 Nodu 必须断开；两边交替进行，不同时打开端口。

## 3. 有意偏离（现代 IDE 优先）

| 原版 | Nodu | 理由 |
| --- | --- | --- |
| ⌘P 打印 | ⌘P 保留为快速打开；打印只在菜单 | 快速打开是现代 IDE 的核心快捷键；打印很少用 |
| ⌘E 输入查找字符串 | ⌘E 保留为连接（原版工具栏连接同为 ⌘E） | 原版两处冲突，连接是主流程 |
| 资源“先删后解压” | 暂存后原子换入 | 避免更新失败丢资源，用户看到的流程不变 |
| 资源包无完整性校验 | 默认要求 `.sha256` | 地址可配置后需防篡改 |
| 安装成功后直接退出 | 提示后提供“立即重启” | 少一步手动重开 |

## 4. 门禁

每阶段结束：

- `cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
  `cargo test --workspace`、`cargo deny check`（阶段 1 新依赖）。
- `npx tsc -p scope-extension --noEmit`、`node scope-extension/test/backend-validation.cjs`。
- `node scripts/check-licenses.cjs`。
- 阶段 1：本地 `http://127.0.0.1` 测试服务器覆盖版本解析、取消、SHA 不符、
  zip-slip、超限、换入失败回滚、`-update_resources`。
- 阶段 2/3：菜单项和快捷键的单元测试；Electron 实例中人工点验并截图。
- 阶段 4/5：证据文档和截图入库（截图可能含用户路径，按 `artifacts/` 规则处理）。

验收逐项见 [acceptance.csv](acceptance.csv)。
