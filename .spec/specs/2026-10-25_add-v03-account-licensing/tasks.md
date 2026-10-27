# Nodu 0.3 账号、AI 服务商与设备授权 - 任务拆解

## 使用规则
- 2026-10-25 用户已授权 spec:run，由主 agent 集成、多个 GPT 子智能体实施；按依赖开始 32 项任务的可执行部分。分支创建、分析交付和子智能体自报均不冒充功能完成。
- 每项一个稳定 `id`；先满足 `depends-on`，再按 `boundary` 实施，实际运行 `verify` 才可勾选。工作量和上线日期待 P0 证据后重估。
- 下文 `EXT` 表示已获准建立的独立云仓任务包，不是本分支的可写目录。其内部模块路径由接收方在准入时锁定，禁止本地执行器跨仓自动写入。云交付必须提供仓库/分支/commit、契约版本和可复现测试证据，再回写本包验收。
- 桌面命令从 `desktop/` 执行：`npm run test:tutor --workspace @scope/studio-extension` 是已有完整教学回归；新测试文件须在对应任务中创建并注册，不能把尚不存在的脚本写成当前测试通过。
- 新 Rust 命令从仓库根执行；新增 crate 前 `cargo test --manifest-path desktop/native/Cargo.toml -p nodu-identity` 不存在，须由身份任务建立。
- 云验证从 EXT 根执行；`go test ./...` 是拟议的 Go 工程验收命令，接收方须补充锁定版本、数据库/Redis 启动方式和集成测试入口。资金/并发的双副本实验不能用单进程 mock 代替。
- 所有证据使用测试账号/假密钥/假上游；真实凭据不进入文档、日志和命令行。真实收费、授权码、平台身份采集与云发布需单独授权。

## P0：先锁契约和风险探针（5 项）

- [ ] 固化增量契约、源码映射和六项状态机缺口
  - id: task-contract
  - owner: 桌面/云接口负责人，主线程集成
  - boundary: `docs/0.3/API-CONTRACT.md`、`docs/0.3/DESIGN.md`、新增 `desktop/scope-extension/src/common/{account,ai,licensing}/` 契约与 `test/ai-contract.cjs`；仅必要 tutor 类型桥接，不改教学算法。
  - verify: 运行 extension compile 和 `node --test scope-extension/test/ai-contract.cjs`；冻结 G1–G6、可信 connection/window、profile/selection CAS、lease/拒绝/恢复版本、refresh 重试规则、request/attempt/settlement 与 slot 状态机；非法/缺字段、同键异参、旧 revision 样本均被拒绝，三端契约可对照。
  - acceptance: 将原方案 `native/` 修正为 `desktop/native/`；明确 chat/line/step/goal/test/discovery 的 gate 与本地 inspect 的排除项。

- [ ] 锁定云底座版本、许可证和唯一结算责任探针
  - id: task-upstream-lock
  - owner: 云负责人；许可决策由项目负责人确认
  - boundary: `docs/0.3/` 的选型决策与隔离 PoC 证据；只在获准的临时实验环境运行候选上游，不创建公开 fork、不使用真实余额。
  - verify: 记录确切 commit/镜像 digest/LICENSE/NOTICE/SBOM 和合规决策；在该版本执行假上游流式请求、发送前失败、usage 缺失、取消/退款实验，记录 relay 的预扣/结算调用链和一个扣款 owner，证明无外内双扣；单读 README 不算完成。
  - gate: D1 未解决时只能研究/PoC，正式云实现不放行。

- [ ] 验证系统浏览器 PKCE 与轮换失响应行为
  - id: task-pkce-poc
  - owner: 身份负责人
  - depends-on: task-contract
  - boundary: 独立本机 PoC/测试夹具及 `docs/0.3/` 证据；使用测试身份服务，不保存用户账号凭据，不接入正式 UI。
  - verify: 运行成功/取消/超时、随机 loopback 端口、恶意 redirect、错误 state/verifier、code 二次消费测试；模拟 refresh 轮换提交后响应丢失并按 G4 重新登录，不由通用 HTTP 重试器重放 token；回调 URL 和 renderer 不出现 token。覆盖 A01–A04。

- [ ] 验证三平台设备信号、不可导出密钥和安全存储能力
  - id: task-device-poc
  - owner: Rust/平台负责人
  - depends-on: task-contract
  - boundary: 隔离设备身份 PoC、候选依赖及 `docs/0.3/` 平台能力表；不改 `nodu-embedded`，不放松 workspace unsafe 禁令。
  - verify: macOS arm64、macOS x64、Windows x64 实机运行 create/sign/verify、升级/密钥丢失、零/重复 UUID、克隆/外设变化实验；记录机型、API 返回、密钥导出失败及保护等级；首次采集前有同意动作。缺实机项保持未完成，不以交叉编译或客户端自报替代。覆盖 L05–L07、L10。
  - gate: D2 决定后续支持矩阵；若强 attestation 不可实现，先收窄支持范围。

- [ ] 建立云端独立任务包和跨仓接收边界
  - id: task-cloud-handoff
  - owner: 项目负责人/云负责人
  - depends-on: task-contract, task-upstream-lock
  - boundary: 本包的外部依赖记录与云端接收契约；云仓仅在授权后由其独立任务包创建 integration branch，不在本分支创建云源码。
  - verify: 记录实际云仓、维护者、独立分支/任务包、选型决策、契约版本及本清单云任务映射；云任务具备具体路径和验证入口，未接收前不得标记云实现已开始。
  - gate: D6；这项是跨仓准入，不是创建公开仓库/部署的自动授权。

## P1：基础设施与官方身份（5 项）

- [ ] 搭建云扩展、迁移、RBAC、审计和 outbox
  - id: task-cloud-foundation
  - owner: EXT 云负责人
  - depends-on: task-cloud-handoff
  - boundary: EXT 内锁定的 Nodu 扩展模块、编号迁移、开发环境及后台最小入口；复用上游用户 ID 和钱包，不复制密码库或余额。
  - verify: 在 EXT 运行单测与数据库集成测试；空库/已有库迁移、回滚兼容、RBAC/CSRF、审计脱敏、outbox 重放通过；至少两个应用副本共享同一 PostgreSQL/Redis 启动成功，保存接收包证据。

- [ ] 实现云桌面授权、会话轮换与撤销
  - id: task-cloud-auth
  - owner: EXT 身份负责人
  - depends-on: task-cloud-foundation, task-pkce-poc
  - boundary: EXT 的 desktop_session/authorization_attempt、OAuth authorize/token/revoke 和 `/me`；复用网页登录，不下发管理员 cookie/token/渠道 key。
  - verify: EXT 账号集成测试覆盖 A01–A04；两副本争抢 code/refresh 只有一次消费，旧 refresh 重放撤销 family，新请求即时拒绝禁用账号；轮换丢响应按冻结规则处理，scope/redirect/PKCE 校验通过。A06 此处仅用带已知归属资源的 fixture 验证授权中间件；真实 requests 查询/取消的正反例由 task-settlement 实现后验收，不把未实现端点的 404 当作越权防护通过。

- [ ] 实现桌面账号服务和多窗口登录生命周期
  - id: task-desktop-auth
  - owner: Node/桌面身份负责人
  - depends-on: task-cloud-auth, task-credential-vault
  - boundary: `src/node/account/`、对应 common RPC、Electron 系统浏览器入口与 Node DI、`test/account-session.cjs`；不接管任意 renderer OAuth URL，不改课程 store。
  - verify: compile 后执行 `node --test scope-extension/test/account-session.cjs`；完成 A01–A05、A07，覆盖取消/超时清理、single-flight、断线/重放、退出撤销及官方队列失效；退出不删自定义许可和代码、不停编译/烧录。

- [ ] 统一凭据 vault 并定义安全存储降级规则
  - id: task-credential-vault
  - owner: Node/平台负责人
  - depends-on: task-contract, task-device-poc
  - boundary: `src/node/account/credential-vault.ts`、现有 `node/tutor/tutor-ai-settings-store.ts` 的凭据委托、受限平台桥接及 `test/credential-vault.cjs`；不改用户真实 key，不新建明文配置存储。
  - verify: compile 后运行 vault 与既有 `tutor-ai-settings.cjs`；provider key 仅可写/删，RPC 无 getSecret；官方 refresh/设备会话按平台保护策略处理，安全存储不可用时明确拒绝持久化或经确认会话内使用；origin 变化不沿用 key、删除失败不得伪报成功，日志/文件/renderer 持久化扫描无测试秘密。

- [ ] 实现独立 Rust 身份 sidecar 与受限本机桥接
  - id: task-device-host
  - owner: Rust/Node 负责人
  - depends-on: task-device-poc, task-contract
  - boundary: `desktop/native/crates/nodu-identity/`、必要 Cargo 依赖、`src/node/licensing/identity-host.ts` 和协议测试；不在 embedded 服务添加身份方法。
  - verify: 运行 `cargo test --manifest-path desktop/native/Cargo.toml -p nodu-identity` 与身份 host 测试；限长/非法 JSON/进程退出/重启/超时/非白名单动作正确处理；仅既定域、purpose、body digest 可签名，无私钥导出和任意消息签名 RPC；拒绝错误 kid/alg/aud/issuer/设备摘要/时间，保持 unsafe 约束。

## P2：许可证完整闭环（4 项）

- [ ] 实现一次兑换、challenge 与提交后恢复
  - id: task-activation
  - owner: EXT 许可负责人
  - depends-on: task-cloud-foundation, task-device-poc
  - boundary: EXT 的 challenge/activate/activation-result、码/绑定/幂等记录和事务；签名摘要与业务幂等摘要分开。
  - verify: 两副本真实 DB/Redis 实验覆盖 L01–L04、L13；两机同码仅一份 license/binding，同 request 同设备重试返回同结果、异参 conflict，提交后签名失败可恢复；新 nonce 重试不重复消费；日志不含激活码、proof/密钥正文。

- [ ] 实现云 lease、撤销版本和设备会话轮换
  - id: task-lease-server
  - owner: EXT 许可负责人
  - depends-on: task-activation
  - boundary: EXT 的 renew/status、固定算法签名、公钥轮换、license/binding revision、策略与设备 refresh family；不把设备身份用作用户 access。
  - verify: 云许可测试覆盖 L08、L09、L12、L15、L16；每次续租 proof/nonce 有效、旧绑定/旧 family 被拒绝、拒绝/恢复响应符合 G2、kid 轮换保留有效旧公钥；online_required 校验与单次 request ID 绑定，不预取通行许可。

- [ ] 实现本机验租约、离线规则与撤销水位
  - id: task-license-client
  - owner: Node/Rust 许可负责人
  - depends-on: task-lease-server, task-device-host, task-credential-vault
  - boundary: `src/node/licensing/`、公开许可状态、身份 host、`test/device-license.cjs` 和原生 lease 用例；只保存最少摘要，不触碰 MCU。
  - verify: Node/Rust 测试覆盖 L05–L09、L12、L13、L15、L16；网络故障只用剩余 lease，已知撤销/错签名/设备变化/时钟异常立即阻断；恢复旧缓存、迟到旧 renew、低 revision 恢复不得放行；首次离线拒绝；online_required 在实际出队每次请求重新校验。

- [ ] 实现授权管理、恢复、换绑和解除绑定
  - id: task-license-admin
  - owner: EXT 许可/后台负责人
  - depends-on: task-lease-server
  - boundary: EXT 的 activation-batches、license admin UI、恢复凭据/转移票据、审批/RBAC/审计；不提供再次查看明文码，不复活已兑换码。
  - verify: 云测试和后台实测覆盖 L03、L08、L10–L14、B11；生成/导出/重试幂等，导出中断处置明确；无账号恢复凭据一次展示后只留摘要，换绑旧 revision 失效；默认重叠窗口明确、严格单机等待/交还可证；危险动作二次确认与权限隔离通过。
  - gate: D3 策略需明确；客户端上报 hardware-backed 不作为服务端 attestation 证据。

## P3：统一请求边界与服务商增量（6 项）

- [ ] 接入统一 AccessDecision 和请求执行快照
  - id: task-access-gateway
  - owner: Node AI 负责人，主线程持有公共 DI
  - depends-on: task-desktop-auth, task-license-client, task-profiles
  - boundary: `src/node/ai/`、`node/tutor/tutor-backend-binding.ts`、公共权限 RPC、最小 tutor provider 注入桥接与 `test/ai-access.cjs`；保留 complete 接口，不重写教学解析。
  - verify: 运行新 access 测试及完整 `test:tutor`；chat/line/step、goal 生成/AI 检查、testModel 和模型发现均命中受控边界；旧 builtin/localhost 直连无免授权旁路；伪造 renderer 身份/route 被拒绝；profile/selection/access/teaching 版本相互独立，双窗口同工程不同 provider 不串线。

- [ ] 实现本地调度、出队复核和精确取消
  - id: task-scheduler
  - owner: Node AI 负责人
  - depends-on: task-access-gateway
  - boundary: `src/node/ai/request-scheduler.ts`、Gateway 生命周期、最小教学队列桥接与 `test/ai-scheduler.cjs`；不改行记录含义和硬件停止接口。
  - verify: compile 后运行 scheduler 测试与 `test:tutor`；覆盖排队中退出/换 provider/lease 到期、校验期间撤销、30 秒快照过期、20 项容量、行 ID 合并保留、429 Retry-After 和断线不重放；出队发送前重查版本，失败归还资源；单窗取消不波及他窗、账号撤销跨窗生效，迟到结果不可应用。

- [ ] 升级 provider schema、选择 CAS 和网络目的地策略
  - id: task-profiles
  - owner: Node/common 负责人
  - depends-on: task-contract, task-credential-vault
  - boundary: `common/tutor/tutor-ai-config.ts`、`node/tutor/tutor-ai-settings-store.ts`、新 profile/network-policy 契约与 `test/provider-profiles.cjs`；只做旧 schema 增量升级，不静默启用官方 route。
  - verify: 运行 profiles 测试与 `tutor-ai-settings.cjs`；账号 profile 不可由用户伪造，旧内置 GLM 明确转为 custom；CAS 冲突/只读 capability 可信来源可判定；完整 operation URL 不重复拼路径，模型 ID 保留大小写；userinfo/query/metadata/跨源重定向拒绝，localhost HTTP 和显式 LAN HTTP 分别处理，公网 HTTP 禁止；私有 CA/代理不泄漏凭据。

- [ ] 补齐三协议 usage、能力和稳定错误
  - id: task-adapters
  - owner: Node provider 负责人
  - depends-on: task-profiles
  - boundary: `node/tutor/tutor-model-gateway.ts` 的增量适配、内部统一流事件及 gateway 测试；不重写已存在 SSE/UTF-8/SecretGuard，不启用工具执行。
  - verify: 运行 `node --test scope-extension/test/tutor-model-gateway.cjs` 与新增协议 fixture；三协议各覆盖正常/碎片/取消/超时/401/403/429/5xx/usage 缺失/不支持结构化输出，usage 不重叠计数，provider 401 不冒充账号失效；测试请求无项目代码、无 key 回显、无隐式跨商切换/生成重试。

- [ ] 增量完成官方、自定义、设备授权设置与空态
  - id: task-settings-ui
  - owner: 桌面 UI 负责人
  - depends-on: task-access-gateway, task-license-admin, task-official-provider, task-adapters
  - boundary: 现有 `browser/nodu-ai-provider-settings.tsx`、`nodu-tutor-model.ts`、`nodu-tutor-widget.tsx` 的状态接入，新增 account/licensing 对话框与必要 tutor 样式；不改全局布局和教学算法。
  - verify: UI 状态测试及实际 GUI 验证：未启用双入口不自动开浏览器/采硬件、官方与自定义独立、明确错误行动；980×720/窄侧栏/200%/深浅主题/键盘 Tab-Esc-焦点恢复/读屏标签通过；不新增常驻余额/运营栏，基础 IDE 和本地检查始终可用。

- [ ] 实现旧配置、凭据和用户选择的安全迁移
  - id: task-migration
  - owner: 桌面升级负责人
  - depends-on: task-profiles, task-license-client, task-settings-ui
  - boundary: AI 设置/credential migration、迁移提示和 fixture；不修改用户工程、课程进度，不读取真实用户 key 做验收。
  - verify: 在隔离用户目录执行 0.2.2→0.3 升级、重复升级、失败重试和回退实测；包含单 GLM 旧 key、多 provider、无 keychain/损坏文件/删除失败；先确认后迁移，激活前不可请求，密钥不上传/不丢失/不自动赠许可，旧版能力边界说明准确；保存迁移前后 hash 与运行日志，静态 diff 不替代运行证据。

## P4：官方模型、并发和资金（5 项）

- [ ] 实现模型目录、价格版本和单一余额适配
  - id: task-price-catalog
  - owner: EXT 计费负责人
  - depends-on: task-cloud-auth, task-upstream-lock
  - boundary: EXT 的 models/usage/policy、不可变价格版本、唯一钱包适配；不另建第二余额，不把 custom token 花费计入官方账单。
  - verify: 云单测与 DB 集成测试覆盖 A07、B05、B06、B09；价格在接受时冻结，非重叠 cache/thinking 桶和整数/decimal 舍入有向量，额度原子预占不负余额；不可界定成本上界的模型不开放。

- [ ] 实现跨副本接纳槽、租约和故障恢复准入
  - id: task-concurrency
  - owner: EXT 网关负责人
  - depends-on: task-cloud-foundation, task-contract
  - boundary: EXT 的 Redis Lua semaphore、DB 未决占位、owner/fencing、heartbeat、取消/恢复协调器；不声称 BYOK 可云端强限流。
  - verify: 两应用副本+共用 DB/Redis+假上游故障测试覆盖 B01–B03；流尾前不释放，crash/TTL/Redis 丢数据/网络隔离/旧 owner 恢复不重售未知槽；恢复先核对 DB，Redis 故障拒绝新官方请求；严格上游生成上限仅对有可靠取消/硬截止的渠道出证据。

- [ ] 实现官方推理幂等、唯一结算和对账冲正
  - id: task-settlement
  - owner: EXT 计费/网关负责人
  - depends-on: task-price-catalog, task-concurrency
  - boundary: EXT 的 ai requests/cancel/status、request/attempt/settlement 状态机及 relay 最小 hook、预占/扣费/释放/核算/outbox；只有选定 owner 扣款。
  - verify: 两副本资金故障测试覆盖 A06、B04–B09、B12；先创建真实测试推理记录，再验证所有者可查询/取消、他人对同一记录被拒绝，不能用不存在端点的 404 充当 A06。重复请求/同键异参、流中断、取消、扣款提交后失响应、实时回调与对账竞争、outbox 重放不双扣；usage 缺失进入有界待核算、修正写冲正事件；所有 attempt 可追溯且余额只有一个事实源。
  - gate: D4 的核算期限/封顶/退款责任未定时不得接真实付费请求。

- [ ] 接入官方 provider 与稳定目录/错误投影
  - id: task-official-provider
  - owner: Node AI/身份负责人
  - depends-on: task-scheduler, task-adapters, task-settlement
  - boundary: `src/node/ai/providers/official.ts`、官方 HTTP 适配和 Gateway 选择、`test/official-provider.cjs`；不下发上游 key、不允许 renderer 指定官方转发 URL。
  - verify: 使用版本化假云和获准测试环境运行 official-provider 与 `test:tutor`；登录/余额/模型/并发错误分别显示，access 轮换无串线，取消关联同一逻辑请求；官方失败不回落 BYOK，custom key 永不发给官方、official token 永不发给 custom，body/日志无多余上下文。

- [ ] 验证支付回调、退款及未开通关闭路径
  - id: task-payments
  - owner: EXT 运营/计费负责人
  - depends-on: task-settlement, task-license-admin
  - boundary: EXT 已选支付 adapter、订单/退款状态机、管理审计和网页入口开关；不在 IDE 内实现收银台，不接真实资金。
  - verify: B10、B11 的支付沙箱或冻结协议 fixture 验证签名/商户/订单/金额/币种、重复/乱序/延迟 webhook、退款/争议与许可证撤销；浏览器回跳不入账。若未获商户准入，测试并证明购买入口和收款均关闭，真实支付验收保持“未启用”，不得以 mock 宣称沙箱已通过。
  - gate: D5；真实支付启用必须另行授权并提供实际沙箱证据。

## P5：联调、安全与发行（7 项）

- [ ] 完成跨仓契约与端到端状态矩阵
  - id: task-cross-repo
  - owner: 集成负责人
  - depends-on: task-official-provider, task-license-admin, task-settings-ui, task-migration, task-payments
  - boundary: 桌面测试夹具/契约测试、EXT 接收版本记录、隔离联调证据及本包验收文档；不顺手重构业务。
  - verify: 同一冻结契约版本跑 A01–A07、L01–L16、B01–B12 的映射矩阵，记录每项命令/环境/结果；假上游双副本测试与获准小样本真实协议验证分别标记；chat/line/step/goal/test/discovery 所有入口无正常 RPC 旁路，本地检查/编译/下载/串口不中断。

- [ ] 进行身份、隐私、网络与权限旁路安全验收
  - id: task-security
  - owner: 独立安全评审者，主线程验收
  - depends-on: task-cross-repo
  - boundary: 本版账号/许可/网关相关代码、测试和脱敏证据；发现问题回写对应任务范围修复，不扩展到无关硬件模块。
  - verify: 运行 secret/log 扫描、RPC 越权、PKCE/refresh 重放、nonce/purpose/body、endpoint/redirect/metadata、撤销后离线、迟到版本、生产放行 stub 负样本；抓包证明 BYOK 代码/key 只到选定 origin，控制面只收许可必要字段；所有高严重性问题闭合，失败不得勾选。

- [ ] 完成运维、数据留存、密钥轮换与恢复演练
  - id: task-privacy-ops
  - owner: EXT 运维/安全负责人
  - depends-on: task-cloud-foundation, task-cloud-auth, task-license-admin, task-settlement, task-payments
  - boundary: EXT 部署说明、密钥管理引用、最小观测/审计、隐私/数据保留与恢复 runbook；本包只记录验收，不发布生产资源。
  - verify: 隔离环境实跑 DB 备份恢复、Redis 丢失、outbox 重放、kid/pepper 轮换和紧急撤销；证明许可证/账本不依赖 Redis 唯一保存，prompt/代码/secret 默认不落日志；记录鉴权/许可延迟样本，P95<200ms 是待测目标不是现成结果；管理 MFA/RBAC 和留存规则可验证。

- [ ] 接入身份二进制打包、许可清单和发行签名
  - id: task-packaging
  - owner: 桌面发行负责人
  - depends-on: task-device-host, task-official-provider, task-settings-ui, task-migration
  - boundary: `desktop/scripts/build-native.cjs`、`package-electron.cjs`、打包测试、资源许可清单和受控 Electron entitlement；不更新不相关资源。
  - verify: 运行现有打包单测、`npm run build:electron`、`npm run check:licenses`，分别在目标主机执行 `npm run package:electron -- --arch arm64` / `--arch x64`（macOS 也测 universal）；确认 identity 随包且无凭据，记录签名类型和验证输出。商业签名/公证证书缺失就明确发行限制，ad-hoc/unsigned 不冒充正式签名。

- [ ] 完成三平台打包版身份和基础 IDE 回归
  - id: task-platform-acceptance
  - owner: 平台测试负责人
  - depends-on: task-packaging, task-cross-repo
  - boundary: macOS arm64/macOS x64/Windows x64 打包版测试和脱敏证据；不在验收中修改用户工程或真实许可。
  - verify: 三平台各用隔离测试账号/授权执行登录、vault、激活/续租/复制/重装/换绑、冷启动、升级和窄窗键盘验证；未启用 AI 时实测编辑/编译/下载/串口及本地检查；逐平台列证据/待测，虚拟/交叉编译不能替代宣称的真机和硬件保护等级。

- [ ] 验证灰度、升级回滚与撤销不可倒退
  - id: task-rollback
  - owner: 集成/发行负责人
  - depends-on: task-privacy-ops, task-cross-repo, task-migration
  - boundary: 灰度/兼容策略、隔离升级回退演练与恢复记录；生产操作另行授权，不删除新许可证或账本。
  - verify: 实跑新版服务/旧版客户端和迁移后回滚，验证新账本/许可仍可读、旧 lease/缓存/迟到响应不能降低已知撤销水位，恢复不复活激活码；明确旧版自带 key 的直连无法由新云许可完全阻断，发布说明不得隐瞒。

- [ ] 汇总发行证据、关闭阻断项并作发布决策
  - id: task-release
  - owner: 项目负责人，主线程验收
  - depends-on: task-security, task-platform-acceptance, task-rollback
  - boundary: 本任务包、`docs/0.3/` 和版本化发行说明；实际版本升级/commit/push/部署需对应授权，不由规划自动执行。
  - verify: 核对 L01/L02/B01/B04/B09/B10 的阻断证据及 D1–D6 的真实处置；逐项区分实现/自动测试/本机实测/其他平台/真实模型/支付关闭状态；运行 Spec 完整校验，只有全部任务及适用验收真实通过才可标记发行候选完成，未测试不勾选。

---

**当前进度**：由脚本计算；规划交付时应为 0/32，不包含分析工作本身。
