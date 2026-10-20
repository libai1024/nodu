# 0.1.4 阶段 1 修复 + 阶段 2 证据 — 内置示例树

日期：2026-10-20 · 主机：macOS arm64 · 无真实开发板操作。

## 阶段 1 审查修复（本轮）

1. `ensure_safe_url` 由前缀匹配改为 `ureq::http::Uri` 解析：https 放行；http 仅当 authority 无 userinfo 且 host 恰为 `127.0.0.1`/`localhost`。单元测试新增 `http://localhost:80@evil.com/`、`http://127.0.0.1@evil.com/`、`http://127.0.0.1.evil.com/`、`http://localhost.evil.com/`、`http://[::1]/`、非法串共 6 个拒绝用例（`tests::url_policy`）。
2. `nodu-update.tsx` 错误文案：`网络请求失败“<url>”！` 与 `无法打开资源文件“<url>”！` 为独立句（标题仍为 `包更新`），仅兜底分支保留 `错误：%1！`。sidecar 所有 ureq 错误已带 `network request failed` 前缀，前端按此前缀分类。
3. `NoduResourcesServer.checkResources` / `installResources` 先 `await this.ready()`：启动重置未结束时不再读到 0.0.0，也不会与重置争抢资源目录。

## 阶段 2 — MaixPy-v1_scripts 内置示例

- 新脚本 `desktop/scripts/vendor-examples.cjs`（`npm run vendor:examples`）：
  - 源默认 `<repo>/../nodu-refs/MaixPy-v1_scripts`，`--source`/`--dest` 可覆盖；
  - `git rev-parse HEAD` 必须等于 `8d7c5f98ba654d226f433d31718d852674cab08d`，否则退出 1；
  - 递归拷贝 `*.py`（≤256 KiB，超限列出 skipped），忽略点目录与 `__pycache__`，非 .py 资源一律不拷；另拷根 `LICENSE`、`README.md` 到 `examples/`；
  - 类别落在 `examples/` 根（`application/ basic/ board/ hardware/ machine_vision/ modules/ multimedia/ network/`），保留既有 `examples/Nodu/`；
  - 幂等：按旧 `manifest.json` 记录的顶层类别先删后拷，绝不触碰 `Nodu/`；
  - `manifest.json`：`{source, commit, files:[{path,bytes,sha256}]}` 排序后原子写入，确定性输出。
- 本机执行结果：**160 个 .py（468 427 字节）+ LICENSE + README.md，0 个 skipped**；连同 Nodu 6 个 `.py`，`examples/` 共 166 个 `.py`（952K）。
- 示例菜单（`nodu-file-docs.tsx` + 新纯模块 `src/common/nodu-examples.ts`）：
  - 上限提升：深度 ≤5、文件 ≤1000；
  - `buildExampleTree`：`Nodu` 置顶，其余目录 `Intl.Collator('en', {numeric:true, sensitivity:'base'})` 排序，`demo_2` < `demo_10`；同级目录先于文件，排序键零填充保证 Theia 菜单次序；
  - 单趟收集（每目录一次 `resolve`），注册 ~160 个命令/菜单项仅一次遍历；
  - 打开仍为未保存副本（untitled）。
- `THIRD-PARTY-NOTICES.md`：MaixPy-v1_scripts 行补充内置路径 `desktop/scope-extension/resources/nodu-resources/examples/`、`manifest.json` 溯源与 `vendor:examples` 再生成方式；commit 不变。

## 版本说明

资源树已变但应用版本仍为 0.1.4：已有 `resources-version.json`=0.1.4 的开发机启动时**不会**自动重置（与计划语义一致），可用 `-update_resources` 或删除 `~/.nodu/resources-version.json` 强制；正式发版时随新版本号自然生效。

## 验证命令与结果（实际输出）

- `cargo fmt --all --check`：干净。
- `cargo clippy -p nodu-resources --all-targets -- -D warnings`：0 警告。
- `cargo test -p nodu-resources`：18 集成 + 3 单元全过（`url_policy` 含新增 6 用例）。
- `npm run compile` / `npx tsc -p scope-extension --noEmit`：0 错误。
- `node scripts/build-native.cjs`：darwin-arm64 + darwin-x64 三个 sidecar 全部重暂存（lib 变更后重建）。
- `node scope-extension/test/backend-validation.cjs`：**29/29**，新增 2 项：
  - `vendor-examples …`（426ms）：bogus `--source`（错误 commit 的 git 仓库）按预期失败；160 = `git ls-files '*.py'`(160) − skipped(0)；抽样 sha256 与落盘文件一致；重跑幂等（manifest 逐字节相同、stray 文件被清理、`Nodu/` 标记保留）。
  - `buildExampleTree …`：Nodu 置顶、`demo_2<demo_10`、目录先于文件、深度>5 丢弃、点/`__pycache__` 丢弃、1000 上限。
- `node scripts/check-licenses.cjs`：扫描 392 个 desktop 文件（含 160 个 vendored .py），clean；`git diff --check` 干净。
- `node -e require('../lib/common/nodu-examples')` 由测试用例隐式覆盖（纯模块无 Theia 依赖，可在 node 直接加载）。

## 未验证项

- 菜单真实渲染次序（Theia CompositeMenuNode 按 sortString/order 排序；本实现用零填充序号显式控制，未在运行中的 UI 截图验证）。
- 大于 256 KiB 的 .py skipped 分支（当前源无超限文件；collectPython 逻辑与输出行已就绪）。
- vendored 文件已留在工作树待 lead 提交；`manifest.json` 为确定性产物，重跑不会产生 diff。
