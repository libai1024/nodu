# Nodu 会话 UI - 验收清单

## 假设与范围对齐
- [x] 无阻塞性待确认项；依据已经完成的Cursor/Nodu UI对照实施。
- [x] 范围内/范围外一致；仅本地会话管理与UI，不新增Agent执行器、Review或账号。
- [x] 保存失败、归档焦点、中文IME和空会话管理问题已在本轮修复并回归。

## 简洁性
- [x] 没有新增依赖、远程接口或额外配置框架。
- [x] 复用现有storage/React/ChatPopover，保留schema1兼容。

## 变更边界
- [x] 产品改动限会话store/model/history/controls/widget、对应CSS及测试。
- [x] 原有未跟踪设计稿未修改；不清理用户数据、不提交或推送。

## 功能完整性
- [x] 短标题、名称编辑、归档恢复、状态时间、搜索与行操作均实现。
- [x] 旧记录、跨窗口、空白draft、错误记录、忙态、workspace切换有回归。
- [x] 存储失败保留memory并显示可重试错误，不静默报告已持久化。

## 测试与验证
- [x] `npm --prefix desktop/scope-extension run test:tutor`：367/367，0失败0跳过，包含TypeScript编译。
- [x] `npm --prefix desktop/scope-extension run test:workbench`：112/112，0失败0跳过。
- [x] 完整桌面GUI验证重命名、归档、Reload Window、归档状态/名称/草稿恢复及恢复归档。
- [x] 真实组件深浅色620/460px视觉检查；宽窄DOM测量无整体横向溢出；搜索匹配和空结果实测。

## 文档同步
- [x] `docs/design/conversation-ui-verification-20261026.md`记录过程、截图索引、限制及复现方法。
- [x] spec/tasks/checklist与实际结果一致，不把失败子代理或取消的键盘动作当通过。

## 部署验证
- [x] 最新Electron开发构建在隔离工程/profile正常启动并重载；原工作窗口未再次操作。
- [x] `npm --prefix desktop/electron-app run build`：browser/node/electron均0 errors；构建SHA256见results.json。

## 边界回归
- [x] 越界负样本：非法id、跨project/mode记录、stale workspace操作均被存储/model/组件回归拒绝；`git diff --check`通过。
- [x] 顺序交换负样本：N/A：本轮不是规则引擎或编排器修改，storage到UI到build的依赖顺序明确，未制造没有意义的任务交换测试。
- [x] 旁路负样本：失败保存、busy/loading、IME确认均有拒绝/保留状态断言；GUI不点击发送，未测试项不计通过。

## 验收证据
- 证据锚点：HEAD ba63cd6bac3ce1aafed17ce5c56b61bd2b8c8a44 @ 2026-10-26T18:47:22+08:00
- 外部对标：已完成的Cursor 3.24.12 IDE逐项UI报告；本轮只落实其中会话辨识与管理，不声称功能全等。
- 脚本验证：`npm --prefix desktop/scope-extension run test:tutor` 367/367；`npm --prefix desktop/scope-extension run test:workbench` 112/112；`git diff --check` exit 0。
- 旧新对比：从长首问标题/无行管理/无时间变为短标题+完整重命名、可恢复归档、双行摘要与相对时间；不再继续重画已接近的composer。
- 差异边界：10个产品及测试文件；额外新建隔离fixture、验收报告、结果JSON和本任务记录；既有未跟踪设计稿保留。
- 行为成效：真实桌面把草稿重命名为“串口验收 A”，归档后重载，名称/归档/原草稿保持，恢复后列表重新显示；focus回搜索。
- 构建：2026-10-26 16:13:14，前端bundle.js SHA256 a41d29a498030117132f6dbf0651c230d642e35e236b7465424042414be788db。
- 手工验证：Computer Use现场帧、无障碍状态与浏览器DOM尺寸；见验收报告。
- 证据目录：`docs/design/conversation-ui-acceptance-20261026/results.json`及同目录日志（日志受既有*.log忽略规则约束）。

## 问题处置
- 未通过项：保存失败正常返回；证据缺口：元信息未持久化但调用方视为成功；下一步替代动作：检查historyStorageError并保持草稿、重跑失败存储测试；处置枚举：fix_this_round。已修复，最终367/367包含该回归，resolved_current。
- 未通过项：归档导致行焦点消失；证据缺口：操作按钮卸载后无焦点落点；下一步替代动作：成功回调聚焦搜索框；处置枚举：fix_this_round。正式桌面s-180确认focused，resolved_current。
- 未通过项：中文IME确认可提交重命名；证据缺口：表单未区分composition Enter；下一步替代动作：isComposing/keyCode229拦截与专门回归；处置枚举：fix_this_round。回归通过，resolved_current。
- 最终检查：无新增阻塞项；视觉纠偏最多2轮，本轮结束。

**验收结果**：通过
