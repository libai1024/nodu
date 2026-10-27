# Nodu 0.3 版本差距分析与任务安排

## 结论

0.3 是“账号 + 软件许可证 + 官方模型运营”的增量版本，不是从零重写 AI 设置。以 main `de67821403f03cf8e5186adcb9f552e5d757a9a4`（0.2.2）为基线：三协议、多 provider、按连接选择模型、KeyStore 和流取消已存在；官方会话、软件许可、统一访问门禁、账务/分布式并发及身份 sidecar 尚需建设。

本轮只交付规划。32 项后续任务按 6 个里程碑分组，所有功能任务均未执行。任务包位于独立 worktree，原工作区及六份设计原稿保持原样。

## 1. 基线与输入

- 原工作区：`/Users/wangwei/Model/k210-studio`，分支 `codex/ai-tutor-foundation`，HEAD `13b5b3d`；保留原有删除/修改/未跟踪状态。
- 规划 worktree：`/Users/wangwei/Model/k210-studio-v0.3-plan`，分支 `spec/2026-10-25_add-v03-account-licensing`，从同步后的 `main` 创建。
- `git merge-base --is-ancestor 13b5b3d HEAD` 返回 0，规划无需重新合并 AI 基础分支。
- `docs/0.3/` 六份文档在原分支未跟踪，但已被最新 main 纳入 Git；两边哈希一致。尝试复制前检查发现目标已存在而拒绝覆盖，没有发生文档写入。
- 曾产生一份过宽 Git diff 输出（truncated），没有据此判断代码完成情况；后续改用短统计、准确文件读取、SHA-256 和单路径扫描。下文所有代码判断以直接读取的完整相关文件/行段为依据。

| 输入 | SHA-256 |
| --- | --- |
| `docs/0.3/README.md` | `dbed67927fa530c3f7fdf543b54cba81223fbf69349cd178aec7be5d7a5b5343` |
| `docs/0.3/DESIGN.md` | `6540104320930f9e692dd91e8c0c03dd9706af4b74213a2f19fa01ad99b9b38d` |
| `docs/0.3/API-CONTRACT.md` | `da82beafc25f478bc25aff3557510a1a2125391afe001edaca5825d7e5c73fd6` |
| `docs/0.3/ROADMAP-AND-TESTS.md` | `3c597d3272fc344385535e2635377af996ea42373e7e6a5fc63ca80739fdb553` |
| `docs/0.3/research-gateway.md` | `50d04e7f86eb298c0b0b17b182dccac84bd3c4daa2dbab2bfb7acdc8641cbf8e` |
| `docs/0.3/research-identity.md` | `cd8b22f8138b6b2a2be918bca2adc1ef8d5b4afe003d5b42581d7ab743393053` |

六份文档均为输入。主线程精读设计/接口/路线，调研文件作为待 P0 重核的选择依据与哈希基线；本轮未重新联网验证外部项目许可、支付或性能。

## 2. 当前代码与拟议方案的差距

以下路径相对规划仓库根；现有测试文件只能证明有测试定义，本轮未运行功能测试。

| 模块 | 已有事实 | 0.3 增量 |
| --- | --- | --- |
| 三协议 | `desktop/scope-extension/src/common/tutor/tutor-ai-config.ts:6` 定义三协议；`desktop/scope-extension/src/node/tutor/tutor-model-gateway.ts:79` 解析流事件、`:116` 分协议请求体 | 不重做 adapters；补 usage/能力来源/稳定错误及官方路线 |
| 网络与取消 | `desktop/scope-extension/src/node/tutor/tutor-model-gateway.ts:166` 禁跳转/自动重试，`:175` fetch，`:148` 强制取消 reader | 放到门禁和调度器后；统一账号/许可/请求版本，避免测试和教学旁路 |
| provider/settings | `desktop/scope-extension/src/common/tutor/tutor-ai-config.ts:24` 多 profile，`:71` URL 校验，`:83` 直接拼后缀 | 增加 revision/CAS、完整 operation URL 规范化、metadata/网络策略；不误把现有限制宣传为完整 SSRF 防护 |
| 凭据 | `desktop/scope-extension/src/node/tutor/tutor-ai-settings-store.ts:17` KeyStore/内存回退，`:63` 旧 GLM 迁移，`:117` endpoint 改动清 key | 统一 vault；加入官方 token/设备会话分类、删除失败处理、迁移确认与许可条件；不重复抄 keytar |
| 账号占位 | `desktop/scope-extension/src/common/tutor/tutor-ai-config.ts:41` 只有 signed-out；`:126` 拒绝用户编辑 account，`:155` 排除 account 选择 | 真正实现账号/官方 provider；不能只把 status 改 signed-in 就当作接通 |
| 窗口隔离 | `desktop/scope-extension/src/node/tutor/tutor-backend-binding.ts:34` 每连接 selection，`:65` 闭包读取 target；`:80` changed 会取消所有连接 | 保留 connection 作用域，分离选择/共享配置/账号许可版本；单窗切换只取消该窗 |
| 调用入口 | `desktop/scope-extension/src/node/tutor/tutor-backend-binding.ts:99` testModel 直接 streamCompletion；`:108` 发现模型，`:117` goal，`:50` 本地 inspect | chat/line/step/goal/test/discovery 均有明确 gate；inspectBuffer 的 AST/WASI 本地检查保留离线能力 |
| RPC | `desktop/scope-extension/src/common/tutor/tutor-ai-protocol.ts:54` 已有显式白名单 | 在其上增加只读账号/许可投影、受控写入；不能公开 getKey/getRefresh/getPrivateKey |
| UI | `desktop/scope-extension/src/browser/nodu-ai-provider-settings.tsx:25` 已有 provider 管理，`:88` 模型测试，`:113` 密钥输入 | 增加官方/自定义/授权分类和启用空态，不重做整个侧栏；已有模型弹窗焦点实现仍需整套 GUI 实测 |
| Rust/IPC | `desktop/native/Cargo.toml:1` workspace，`:13` unsafe forbid；`desktop/scope-extension/src/node/nodu-embedded-server.ts:79` 独立子进程管道 | 新 `desktop/native/crates/nodu-identity/` 及受限 IPC；只复用进程生命周期模式，不调用 MCU 服务实现授权 |
| 打包/签名 | `desktop/scripts/build-native.cjs:22` 固定二进制列表未含 identity，`:27` 三 target；`desktop/scripts/package-electron.cjs:1235` ad-hoc 非公证，`:1276` Windows 未签名 | identity 打包及平台验收为独立任务；正式签名能力不可由旧构建脚本推定 |
| 云服务 | 跟踪文件和根目录核对没有 Nodu 云服务/Go 工程 | 独立仓库/任务包接收后建设 New API 扩展；桌面不直接读云 DB，不新增第二用户库/钱包 |

### 可复用的现有验证入口

脚本定义可核对 `desktop/scope-extension/package.json:29`；协议测试使用注入假 fetch，见 `desktop/scope-extension/test/tutor-model-gateway.cjs:11`，并包含显式 localhost 传输用例，不依赖真实供应商密钥。

从 `desktop/` 执行（本轮没有运行）：

```sh
npm run test:tutor --workspace @scope/studio-extension
npm run test:tutor-native --workspace @scope/studio-extension
npm run test:tutor-wasi --workspace @scope/studio-extension
npm run test:launcher --workspace @scope/studio-extension
node --test scripts/package-electron.test.cjs scripts/package-stm32.test.cjs
npm run build:electron
npm run check:licenses
```

从仓库根执行既有原生回归：`cargo test --manifest-path desktop/native/Cargo.toml --workspace --locked`。安装依赖和完整构建留给实施阶段；本次不触发下载、原生设备访问或用户 KeyStore。

## 3. 六处契约需要先于实现冻结

GPT 子智能体完成本节安全评审，主线程对照已读原文合并为任务，不将拟议缺口描述为已发生漏洞。

| 编号 | 已有原则与未闭合处 | 先做的工作 |
| --- | --- | --- |
| G1 | API-CONTRACT:153–163 先 gate 后 scheduler；:226 只对 online_required 明确出队云校验 | 所有策略出队后重验，异步校验返回后再次对比 revision；`task-contract`、`task-scheduler` |
| G2 | DESIGN:243–247 要持久撤销水位，但 API 错误/恢复结构及 binding/license/access 版本关系不全 | 定义签名状态/拒绝/恢复及单调水位；`task-contract`、`task-lease-server`、`task-license-client` |
| G3 | API-CONTRACT:95–112 要按窗口选择，RPC/CAS 与 cancelScope 未区分窗口/共享配置 | 可信 connection 绑定与分层 CAS/取消；`task-profiles`、`task-access-gateway`、`task-scheduler` |
| G4 | DESIGN:180 严格 refresh 重放撤销，API-CONTRACT:205 泛称所有写请求幂等 | token 端点重试例外、原子消费与失响应重新登录；`task-pkce-poc`、`task-cloud-auth` |
| G5 | DESIGN:324–328 已要求单结算 owner，但具体 relay 扣款、request/attempt/settlement/CAS 未定 | 锁版本实验后固定账务状态机；`task-upstream-lock`、`task-settlement` |
| G6 | DESIGN:294 已要求 DB tombstone，不缺“故障原则”，缺恢复时的准入/owner 协议 | DB/Redis 占位顺序、fencing、恢复先对账；`task-concurrency` |

不另报已被原文处理的问题：激活 proof 摘要与业务幂等摘要在 API-CONTRACT:224 已区分；已知撤销不可离线回退、hardware-backed 不等于 attested、单结算 owner 和未知上游槽不能重售，都已有原则，工作是把它们变成可执行契约与测试。

## 4. 里程碑、并行与关键路径

| 分组 | 任务数 | 交付 |
| --- | ---: | --- |
| P0 | 5 | 契约、上游锁版/账务探针、PKCE/硬件 PoC、云仓接收 |
| P1 | 5 | 云基础、云/桌面账号、vault、身份 sidecar |
| P2 | 4 | 激活、云 lease、本机许可、授权管理/恢复 |
| P3 | 6 | 统一 gate/调度、profile/协议增量、设置、迁移 |
| P4 | 5 | 目录价格、跨副本槽、唯一结算、官方 provider、支付关闭/启用路径 |
| P5 | 7 | 联调、安全、运维、打包、三平台、回滚、发行验收 |

这些标题是交付主题，不是要求 P3 全部完成才准开始 P4；实际依赖以稳定 ID 为准。规划静态依赖校验应识别：

1. 初始可做 `task-contract` 和 `task-upstream-lock`，其余先满足前置；本轮仍不执行。
2. 契约后 PKCE 与三平台 PoC 并行；云底座准入后 auth、activation、concurrency 可分线推进。
3. 官方路径必须先走 cloud auth、price catalog、concurrency、settlement，再接 official provider；不能把计费留到“登录可用”后无保护上线。
4. 自定义路径必须先有设备身份、激活/lease、vault/profile，再接统一 gate；三协议已有基础，但未授权测试也不能先放开。
5. `tutor-backend-binding.ts`、公共 RPC、共享 profile schema、UI model 由集成者串行合入，不能多人同时重写；云模块按锁定职责分工。
6. 两条 AI 路径汇合后，才做真实的跨仓/双窗口/迁移联调、安全、平台和回滚验收。

不照搬原路线“P4 从零造三 adapter”的工时。原估算 35–51 人日只作历史参考；原生平台可用性、上游结算 hook 与资金故障恢复决定真实关键路径，P0 后重新估算。

## 5. 验收覆盖索引

测试 ID 来自 `docs/0.3/ROADMAP-AND-TESTS.md`。下面是责任映射，不是执行结果；所有测试当前均为未来验收。

| 测试 ID | 主要负责任务 |
| --- | --- |
| A01, A02, A03 | task-pkce-poc、task-cloud-auth、task-desktop-auth |
| A04 | task-cloud-auth、task-desktop-auth |
| A05 | task-desktop-auth、task-access-gateway、task-scheduler |
| A06 | task-cloud-auth 仅授权中间件 fixture；task-settlement 验真实记录查询/取消，task-cross-repo 复验 |
| A07 | task-desktop-auth、task-price-catalog、task-official-provider |
| L01, L02, L03, L04 | task-activation；L03 另由 task-license-admin 验管理端 |
| L05, L06, L07 | task-device-poc、task-license-client、task-platform-acceptance |
| L08, L09 | task-lease-server、task-license-client |
| L10, L11 | task-license-admin、task-platform-acceptance |
| L12 | task-lease-server、task-license-client、task-privacy-ops |
| L13 | task-activation、task-license-client |
| L14 | task-license-admin |
| L15, L16 | task-lease-server、task-license-client、task-scheduler |
| B01, B02, B03 | task-concurrency |
| B04 | task-settlement |
| B05, B06 | task-price-catalog、task-settlement |
| B07, B08 | task-settlement |
| B09 | task-price-catalog、task-settlement |
| B10 | task-payments；未开通真实渠道时测关闭路径，实际沙箱保持未验收 |
| B11 | task-license-admin、task-payments |
| B12 | task-settlement |

额外覆盖：
- 协议/UTF-8/SSE/usage/能力/错误：task-adapters；地址/端口/IPv6/私有 CA/metadata/重定向：task-profiles + task-security。
- key/token/授权码/代码隐私：task-credential-vault + task-security + task-privacy-ops。
- 所有 AI 入口与不受影响的本地功能：task-access-gateway + task-cross-repo + task-platform-acceptance。
- 20 项队列/30 秒过期/行记录保留/无历史重放：task-scheduler。
- 980×720、200%、深浅色、键盘、双窗口：task-settings-ui + task-platform-acceptance。
- 三平台、实际签名类型、升级/回滚/备份/kid 轮换：task-packaging + task-platform-acceptance + task-rollback + task-privacy-ops。

## 6. 本轮证据与未验证事项

- 已执行：分支/worktree 预检及创建，main 祖先关系，六份文档 SHA-256 对比，源码和现有测试定义核对，规划任务依赖/范围/引用/覆盖验证；命令和机器结果见 `validate-plan.py`、`validation.json`、`spec-check.json`。
- GPT 使用情况：按用户要求停止初始 GLM；GPT 安全 lane 经一次精简重试完成。AI 代码/native 两条 GPT lane 均因服务端并发限制两次失败，没有输出可采用结论；收回主线程补齐，不伪称三个 GPT 都完成。
- 未执行：任何 0.3 功能实现、现有功能测试、npm/cargo 构建、硬件采集、真实账号/许可/模型/支付、云部署、外部许可重核、Git commit/push。
- 规划验收与版本验收分开：规划结构应通过；完整 Spec 完成校验预期退出 1，因为 32 项开发任务和发行检查均未做。不能为了让命令变绿勾选实现任务。
- GPT 对最终三份任务文档独立终审，确认 G1–G6 均落到依赖和验收；发现 task-cloud-auth 的真实请求查询验收早于端点实现，现已修订为账号阶段只验授权中间件 fixture，task-settlement 验真实记录所有者/他人的查询与取消，task-cross-repo 复验，不添加反向依赖。
- D1–D6 的外部条件记录在 `spec.md` 第 7 节；它们不是本轮必须回答的问题，也不是已批准商业决策。
