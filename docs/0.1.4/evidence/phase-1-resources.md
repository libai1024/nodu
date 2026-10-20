# 0.1.4 阶段 0 + 阶段 1 证据 — 版本基线与资源/更新流程

日期：2026-10-19/20 · 主机：macOS arm64 · 无任何真实开发板操作。

## 阶段 0 — 版本基线

- `desktop/package.json`、`browser-app`、`electron-app`、`scope-extension` → `0.1.4`；两个 app 的 `@scope/studio-extension` 引用同步改为 `0.1.4`（否则 npm 去 registry 解析 0.1.2 报 404）。
- `desktop/native/crates/*/Cargo.toml` 全部 crate → `0.1.4`。
- 关于对话框回退版本 `FALLBACK_VERSION`（`nodu-file-docs.tsx`）→ `0.1.4`。
- `Cargo.lock` / `package-lock.json` 均由工具更新（`cargo`、`npm install --package-lock-only`），未手改。
- **未创建 `v0.1.3` 或任何 git 标签 —— 按计划待用户确认。**

## 阶段 1 — `nodu-resources` sidecar

新 crate `desktop/native/crates/nodu-resources`（lib + bin），`#![forbid(unsafe_code)]`，workspace edition/lints，clippy pedantic 零警告。

CLI（stdout 仅 JSON 行：`progress`/`phase` 事件 + 末行 `result` 或 `error`，失败非零退出）：

- `check-version --url U --current X.Y.Z` / `check-resources --url U --installed X.Y.Z`
  → `{latest, newer}`；15 s 超时、正文 ≤64 B、trim、原版正则 `^(\d+)\.(\d+)\.(\d+)$`、元组比较。
- `install --url-template T --version V --dest D --version-file P [--sha256]`：模板 `%1 %2 %3` → major/minor/patch；流式下载到 D 的兄弟临时文件（进度事件）；`--sha256` 时取 `<url>.sha256` 首个 64-hex token 校验；解压到兄弟 staging 目录；`D → .bak-<pid>` → `staging → D` 原子换入并删备份，staging 改名失败时回滚旧资源；版本文件最后写入。
- `reset --bundled B --dest D --version V --version-file P`：bundled 树经同一 staging+swap 写入。
- 取消：stdin EOF（Node 关 stdin）→ `{"error":"cancelled"}` + 清理临时文件，非零退出。

安全策略：仅 `https://`（测试允许 `http://127.0.0.1`/`http://localhost`），重定向禁止 https→http 降级；解压拒绝绝对路径/盘符前缀/`..` 段（`/` 与 `\` 两种分隔符）、符号链接与非普通文件；上限 20 000 项 / 512 MiB 总量 / 单文件 64 MiB（按实际写出字节计）；`enclosed_name` 二次校验，绝不写出 staging 之外。

### 依赖（均满足发布 ≥7 天）

| 依赖 | 版本 | 发布日期 | 备注 |
|---|---|---|---|
| ureq | 3.4.2 | 2026-09-13 | `native-tls-no-default`（OS TLS + 系统根证书，同原版 Qt 栈）；`rustls-webpki-roots` 曾选但 webpki-roots / webpki-root-certs 的 `CDLA-Permissive-2.0` 不在 deny.toml 白名单，改走原生 TLS 后 `cargo deny` 全绿、无需改白名单 |
| zip | =9.0.2 | 2026-10-11 | `default-features=false` + `deflate`；8.6.0 命中 RUSTSEC-2026-0368/0369（crate 自身 `extract()` 的符号链接权限路径——本实现不走该 API，但仍按门禁升级）；`=9.0.2` 精确钉死（`9.0.2` 语义会取 9.0.5，<7 天） |

## Node 后端 `NoduResourcesServer`

- `initialize()` 触发 `ready()`：版本文件缺失 / 记录版本 < app 版本（读 `@scope/studio-extension/package.json`）/ `NODU_UPDATE_RESOURCES=1` → 以 bundled `resources/nodu-resources` 执行 `reset` 并写 `~/.nodu/resources-version.json`；失败记日志并回退 bundled examples 目录。
- `ready()` → `{examplesDir}`（`~/.nodu/resources/examples`）。
- `checkVersion(url)` / `checkResources(url)` 生成 sidecar 返回 `{latest,newer}`。
- `installResources(template, version, requireSha256)`：逐行解析 sidecar 输出，`onInstallProgress` / `onInstallPhase` 经 RPC 推送前端；`cancelInstall()` 关闭子进程 stdin。
- 测试钩子：`NODU_RESOURCES_BIN` / `NODU_RESOURCES_HOME` / `NODU_RESOURCES_BUNDLED`。
- RPC 走 `RpcConnectionHandler` + 白名单 facade，与 `nodu-device` 同构。

## 打包与内置资源

- `build-native.cjs`：`names` 加入 `nodu-resources`，cargo 行加 `-p nodu-resources --features nodu-device/mock`（qualified feature，多包构建不影响）；同 fresh-inode 暂存与 macOS lipo universal 处理；已生成 `resources/bin/darwin-{arm64,x64}/nodu-resources`。
- `scope-extension/resources/nodu-resources/examples/Nodu/` 收录当前 `desktop/examples/**/*.py`（board-api 2、gc2145-camera 1、green-tracker 3，共 6 个 .py）；MaixPy-v1_scripts 按计划留待阶段 2。

## 启动器

`launch.cjs`：新 `SWITCH_FLAGS` 表消费 `-update_resources` → 子进程 `NODU_UPDATE_RESOURCES=1`，永不转发给 Theia；帮助文本已更新；`extractLauncherFlags` 单测覆盖。

## 前端

- 偏好 schema（`nodu-update.tsx` → `PreferenceContribution`）：`nodu.update.enabled`(false)、`versionUrl`、`downloadPageUrl`、`resourcesVersionUrl`、`resourcesUrlTemplate`(均 "")、`requireSha256`(true)。
- `NoduUpdateContribution`（`FrontendApplicationContribution`，非阻塞 onStart）：仅 enabled 且所需 URL 非空才发请求。
  - 版本：有新版 → 对话框 `有可用更新` / `Nodu 新版本 (x.y.z) 可供下载。` / `下载`/`取消` → `OpenerService` 打开下载页；失败仅日志。
  - 资源：较新 → `有可用更新` / `有新的 Nodu 资源可用（例如示例、固件、文档等）。` / `安装`/`取消` → `ProgressService` `正在下载…`（可取消 → `cancelInstall()`）→ 收到 `installing` 阶段事件后换 `正在安装…`（不可取消）→ `安装成功！请重启 Nodu。`
  - Electron 存在重启机制：preload `window.electronTheiaCore.restart()`（`CHANNEL_RESTART` → `ElectronMainApplication.restart`，Theia 自带「需重启」对话框同款）→ 弹 `立即重启`/`稍后`；浏览器端仅提示消息。
  - 错误：`包更新` / `错误：%1！`；网络类 → `网络请求失败“url”`；压缩包/校验类 → `无法打开资源文件“url”`；`cancelled` 静默。
- 示例菜单（`nodu-file-docs.tsx`）：基址改为 `resources.ready().examplesDir`（原 `desktop/examples`），深度 ≤2、≤48 项、未保存副本打开、`更多示例` 不变 → 菜单结构 `示例 → Nodu → <组> → .py`。

## 验证命令与结果（实际输出）

- `cargo fmt --all --check`：干净（首次运行对新增文件做了一次 `cargo fmt`，复检通过）。
- `cargo clippy --workspace --all-targets -- -D warnings`：0 警告。
- `cargo test --workspace`：31 个 test-result 全 ok，0 failed；`nodu-resources` 18 集成 + 3 单元测试通过。
- `cargo deny check`：`advisories ok, bans ok, licenses ok, sources ok`。
- `node scripts/build-native.cjs`：darwin-arm64 + darwin-x64 各暂存 `nodu-device`、`nodu-terminal`、`nodu-resources`（universal lipo）。
- `npx tsc -p scope-extension --noEmit`：0 错误；`npm run compile` 通过。
- `node scope-extension/test/backend-validation.cjs`：**27/27**（新增 5 项：缺版本文件重置、低版本重置、`NODU_UPDATE_RESOURCES` 强制、等版本跳过、launcher 剥 `-update_resources`；重置用真实 sidecar 对临时 HOME 端到端验证）。
- `node scripts/check-licenses.cjs`：227 文件 clean。

## 偏差与说明

1. **bin 增加 `{"event":"phase","phase":"downloading|installing"}` 行**：计划只列 progress/result/error，但前端要按原版呈现可取消的「下载」与不可取消的「安装」两段；未知总长（chunked）下载无法用 `downloaded==total` 判断切换点，故补一个阶段事件，属纯增量、Node 按白名单字段解析。
2. **zip 9 `enclosed_name` 语义变化**：9.x 会剥掉前导 `/`/盘符前缀而不是拒绝；为按规范「拒绝绝对路径」，在 `enclosed_name` 之前加显式原始名检查（`/`、`\`、盘符、任意 `..` 段、NUL）。
3. **TLS 换为 native-tls**：见依赖表——`CDLA-Permissive-2.0` 根证书包被 deny 拒绝；native-tls 用系统信任库，同时更接近原版 Qt 行为。未改 `deny.toml`。
4. **测试细节**：Rust `Child::wait()` 会先关闭 `child.stdin` 再等待——测试需自行 `take()` 保住写端，否则 sidecar 一启动即收到 EOF 取消；已按此实现 `wait_collect`。
5. **安装时全局超时**：`check` 用 15 s 硬上限（原版语义）；下载请求给 15 min 全局上限避免大包被误杀。
6. `desktop/examples/green-tracker/.theia/settings.json` 的用户未提交修改（主题改 light）保持原样，未触碰。设备 worker / 串口代码未动。无真实板操作、无提交、无标签。

## 未验证项

- Windows/Linux 上的资源安装与 native-tls 行为（仅 macOS 验证）。
- Electron `restart()` 端到端真实重启（机制已在 Theia 源码确认存在，未在打包 Electron 内实测）。
- 真实 `https://` 下载（网络测试全部 loopback `http://127.0.0.1`）。
- `NODU_UPDATE_RESOURCES` 的端到端链路（launcher→env→后端）各环节已分别测试，未完整跑一遍真实启动。
