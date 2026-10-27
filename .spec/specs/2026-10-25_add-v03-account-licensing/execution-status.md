# Nodu 0.3 实施进度

- 状态：执行中，P0 公共契约实现。
- 授权：2026-10-25 用户要求 spec:run、多个 GPT 子智能体写代码、每 10 分钟报告。
- 集成分支：`spec/2026-10-25_add-v03-account-licensing`。
- 完成任务：0/32；以 tasks.md 和主线程实跑验证为准，不采用子智能体自报直接勾选。
- 定时报送：automation-cdda0c54-e27c-4abb-a596-982147deb06a，每 10 分钟，只读此记录、各 lane 进度和实际 Git/测试证据；不执行开发。

## 首批职责契约

所有 lane 使用 GPT。共享 package.json、docs/0.3、tasks/spec/checklist、公共 AI 执行与资金契约由主线程独占；子智能体不得改这些文件，不得 commit/push、切换分支、操作原工作区或读取真实凭据。

| lane | 对应任务 | 独占写范围 | 交付与验证 |
| --- | --- | --- | --- |
| account-contract | task-contract 子范围 | src/common/account/account-protocol.ts；test/account-contract.cjs；progress/account-contract.md | 账号投影、PKCE/refresh/错误与授权中间件 fixture 契约，Node 单测；主线程统一 compile/验收 |
| license-contract | task-contract 子范围 | src/common/licensing/license-protocol.ts；test/license-contract.cjs；progress/license-contract.md | proof/lease/revision/恢复/离线策略的类型和严格运行时校验，Node 单测；无真实密钥/硬件访问 |
| profile-contract | task-contract 子范围 | src/common/ai/provider-profile.ts；test/provider-profile-contract.cjs；progress/profile-contract.md | 增量 provider summary/input/CAS、兼容旧格式的纯函数契约，Node 单测；不改现有设置实现 |
| upstream-poc | task-upstream-lock | docs/0.3/poc/upstream-lock.md；本包 evidence/upstream-*；progress/upstream-poc.md | 锁定官方上游 commit/LICENSE/NOTICE/结算调用链与可行的本机假上游实验；无生产/付费/公开仓库 |
| main | task-contract 集成 | common/ai/ai-access-protocol.ts、inference-contract.ts、test/ai-contract.cjs、package.json、docs 和任务包 | G1/G3/G5/G6 契约、独立 compile/测试、源文档同步与最终任务验收 |
| security-review | task-contract 安全复核 | 只读上述新增契约/测试 | 验证门禁时序、版本隔离、重放/撤销和资金槽状态，不直接改代码 |

上述 src/test 路径均相对 `desktop/scope-extension/`。每个 lane 在 progress 文件记录 ISO 时间、当前动作、修改文件、已跑/未跑测试、阻塞。文件未更新不等于仍在运行。

## 约束与待核查

- P0 后依赖就绪才能开展后续实现，不提前勾选硬件/云端任务。
- D1 商业许可/源码提供、D2 三平台真实身份、D3 离线恢复政策、D4 资金政策、D5 商户/签名/生产资源、D6 云仓接收仍是相应准入门槛。
- 原工作区与规划 worktree 的 package-lock 并非逐字相同，主线程先比较差异再决定隔离依赖准备，不能直接共享可写 node_modules。
- 完整产品验收预期尚未通过；本文件不是发布声明。
