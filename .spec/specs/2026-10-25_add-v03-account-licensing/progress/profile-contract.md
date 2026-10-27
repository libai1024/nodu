# Provider profile contract slice

- 2026-10-25T07:48:26Z — doing — 精简重试已开始；已核对分支为 `spec/2026-10-25_add-v03-account-licensing`。
- 独占写范围：`desktop/scope-extension/src/common/ai/provider-profile.ts`、`desktop/scope-extension/test/provider-profile-contract.cjs`、本进度文件。
- 目标：严格 public/input validator、profile/selection 双 CAS、旧 builtin/custom → custom 的纯兼容映射；secret 不进入公开读模型，account 仅由受信后端生成。
- 边界：不改 UI/store/旧配置/其他 common/package/docs/任务三件套；不联网、不使用密钥或硬件、不安装依赖、不 checkout/commit/push；统一 compile 留给主线程。
- 当前阶段：读取既有 tutor config 和 API 契约，确认既有 scheme、字段及基线。
- 验证状态：尚未运行测试；后续记录实际命令及结果，不以源码检查代替执行。
- 阻塞：暂无；node:test 依赖主线程统一编译的 `lib/common/ai/provider-profile` 产物。
