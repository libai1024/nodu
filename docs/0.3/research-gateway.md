# 0.3 中转站底座核对

核对日期：2026-10-23。仅研究官方仓库、官方文档和公开源代码，没有部署、压测或支付实测；未修改 AI 教学代码。以下“未确认”不能在实施计划中当作现成功能。

## 选型结论

有条件首选 **QuantumNous/new-api**：账号、模型渠道、计量及订阅基础最符合本次需求，采用独立云端 fork，在其中增加 Nodu 桌面授权和设备许可证模块。接受并履行 AGPL 和附加署名要求，或取得适合实际部署方式的商业许可，是选择前提。

**songquanpeng/one-api** 是宽松许可备选，但新增协议、订阅和维护投入明显更大。**VoAPI/VoAPI** 当前公开仓库不适合当作可源码二开的商业底座：其许可限制个人非商业使用，公开 `main.go` 仅包含打印语句，README 的产品功能表不能替代完整实现源代码。

## 候选核对

| 项目 | 已核实可复用 | 待补或须验证 | 采用判断 |
| --- | --- | --- | --- |
| [New API](https://github.com/QuantumNous/new-api) | 用户、组、API Key、OAuth/OIDC 接入、2FA、登录会话；多协议网关、额度、缓存用量、价格；订阅模型及重置任务 | 桌面 PKCE 授权服务器、一次性设备许可、严格跨节点活动请求并发、结算幂等和实际协议兼容需专项实现/验收 | 功能最匹配；不能把最新 RC 直接当生产基线 |
| [One API](https://github.com/songquanpeng/one-api) | 用户注册登录、邮件找回、第三方登录、渠道/令牌/用户额度、分组倍率、余额充值码 | 当前主干中未核实完整订阅产品；统一 OpenAI 入口不代表具备最新 Anthropic/Responses 完整语义；严格并发、设备许可与桌面授权需新增 | 闭源扩展候选，维护与协议补齐预算应单列 |
| [VoAPI/VoAPI](https://github.com/VoAPI/VoAPI) | README 宣称用户、运营套餐、兑换码、定价和 RPM/TPM | 公开仓库不提供足以核对这些功能的业务源码；并发与 RPM/TPM 不能等同；授权限制不满足本次商业化方向 | 本次排除，不与其他同名/近名仓库混用结论 |

New API 的认证能力依据 [README](https://github.com/QuantumNous/new-api/blob/main/README.md) 和 [认证文档](https://github.com/QuantumNous/new-api/blob/main/docs/authentication.md)。这是应用已有的账号能力，不代表它天然是 Nodu 的 OAuth/OIDC 授权服务器。API Key 是调用模型的凭证，也不替代桌面用户登录会话。

One API 的用户和渠道能力见 [官方 README](https://github.com/songquanpeng/one-api/blob/main/README.md)。VoAPI 的可审查代码范围见 [仓库树](https://github.com/VoAPI/VoAPI/tree/main) 和 [main.go](https://github.com/VoAPI/VoAPI/blob/main/main.go)；不基于宣传页对吞吐量或稳定性作保证。

## 许可证与维护状态

| 项目 | 许可证核对 | 2026-10-23 读取的主干证据 |
| --- | --- | --- |
| New API | AGPLv3；`NOTICE` 另要求保留作者归属声明和显著的原项目链接，修改来源不能误导。云端修改版的相应源码提供义务不能靠改名规避 | [33c61a2](https://github.com/QuantumNous/new-api/commit/33c61a24234aa20cb10e8a644304322c476361de)，2026-10-23；发布页显示持续更新及 RC 版本 |
| One API | LICENSE 为 MIT，需保留版权与许可通知；README 另要求页脚署名和链接，若要移除先取得授权，不能把它写成无条件白标方案 | [8df4a26](https://github.com/songquanpeng/one-api/commit/8df4a2670b98266bd287c698243fff327d9748cf)，2025-02-21；仓库最近 push 不等于主干代码最近更新 |
| VoAPI/VoAPI | LICENSE 限个人非商业使用，不是可以直接商用二开的宽松许可 | [8a9b22f](https://github.com/VoAPI/VoAPI/commit/8a9b22f6e5a8d9bdaddeb5454af6629b89dfc802)，2026-01-27；公开实现不完整 |

直接依据：[New API LICENSE](https://github.com/QuantumNous/new-api/blob/main/LICENSE)、[New API NOTICE](https://github.com/QuantumNous/new-api/blob/main/NOTICE)、[One API LICENSE](https://github.com/songquanpeng/one-api/blob/main/LICENSE)、[One API README 说明](https://github.com/songquanpeng/one-api/blob/main/README.md)、[VoAPI LICENSE](https://github.com/VoAPI/VoAPI/blob/main/LICENSE)。许可范围应结合最终组合和分发方式确认，本文不推断整个 Nodu 桌面程序必然适用何种许可证。

New API [发布记录](https://github.com/QuantumNous/new-api/releases)包含计费/限流修复及架构变动，部分 RC 记录明确不建议生产使用。实施时应固定具体 commit、完整许可和镜像 digest，做升级迁移与回滚演练；不要采用浮动 `latest` 并依赖未经验收的实验插件。

## 定价、订阅、频率、并发需要分开

New API 的 [subscription.go](https://github.com/QuantumNous/new-api/blob/main/model/subscription.go)已包含订阅计划、订单、用户订阅实例、到期状态、日/周/月/自定义周期重置以及是否允许用钱包继续支付的策略。对应 [重置任务](https://github.com/QuantumNous/new-api/blob/main/service/subscription_reset_task.go)存在。可以复用这些实体，而不是重新写一套余额订阅数据库；Nodu 应固定计划版本、账单价格快照，并明确套餐耗尽是否允许继续扣余额，不能默默切换。

New API [官方功能说明](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/feature-guide/index.mdx)包含模型价格和订阅管理。价格配置存在不等于已完成 Nodu 的订单审计、支付回调幂等、退款与对账，这些仍是上线验收项。

[New API 模型限流源码](https://github.com/QuantumNous/new-api/blob/main/middleware/model-rate-limit.go)核实到的是时间窗口内请求次数及成功次数；[One API 限流源码](https://github.com/songquanpeng/one-api/blob/main/middleware/rate-limit.go)也有按 IP 的时间窗机制。本次未确认任何一者原生满足“一个账号最多同时存在 N 条未结束 SSE，跨进程、跨服务器一致”的全部要求。

因此 Nodu 的受控请求并发应在云端新增/验证独立 Redis 原子租约：同账号的所有设备/令牌共享计数，准入后占用，确认结束/取消后释放。失联不能仅因 Redis TTL 到期就释放席位；还需数据库请求状态、隔离期与上游终止证据/硬截止时间，具体见主设计。Redis 故障时拒绝新计费请求。账号级、渠道级并发与 RPM/TPM、预算分别配置；无法可靠终止的上游不承诺绝对限制其仍在生成的任务数。

协议方面，New API 宣称 OpenAI、Claude、Gemini 兼容转换；仍须用 Nodu 的真实工具调用、SSE 终止、取消、usage 和错误案例验证，不假设转换无损。自定义服务商选择不同协议时应直连对应适配器，不先强行压成一个最小公分母再转换。

## 新要求：授权码绑定设备

现有充值码不能复用为设备许可证。New API [redemption.go](https://github.com/QuantumNous/new-api/blob/main/model/redemption.go)的核心操作是将可用码置为已使用并增加用户 quota；One API 的 [redemption.go](https://github.com/songquanpeng/one-api/blob/main/model/redemption.go)同属账户充值领域。它们不提供物理硬件绑定、设备密钥证明、许可续租、换机或撤销。

在同一个中转站 fork 中增加以下模块，复用上游管理账号、权限及审计，但不混用余额表与授权表：

- `license_codes`：管理员批次生成一次性随机码，仅存校验哈希、批次、期限、状态、可激活策略；明文仅生成/导出一次。
- `device_licenses`：绑定设备摘要与设备公钥、授权功能、激活时间、有效期、状态和撤销版本。
- `license_leases`：短期签名许可与挑战记录；续租校验设备持有私钥、硬件策略和服务端状态。
- `license_audit`：生成、激活、撤销、换绑、失败尝试。操作权限与上游充值码权限分开。

桌面 API 统一采用 `/nodu/v1/license/activate`、`challenge`、`renew`、`status`，管理 API 采用 `/nodu/admin/v1/activation-batches` 与 `/nodu/admin/v1/licenses/*`，以 [API 契约](API-CONTRACT.md) 为准。这些是拟议新增接口，上游并未提供。激活使用数据库事务和状态条件更新，确保两个设备同时兑换时只有一个成功；授权码不是长期 bearer token。

云端两条身份路径独立：官方 AI 用登录账号、额度、模型权限和并发门禁；自定义服务商用有效设备许可证解锁，本机保存用户自己的 endpoint、协议、模型与密钥，请求直达用户选定服务商。云端授权校验无需收到自定义 API Key 或用户代码。不把账号登录自动等同于已购买自定义许可，也不把设备许可当作官方模型余额。

设备摘要加软件私钥不能证明不可复制的物理硬件；具备 TPM/Secure Enclave 时可强化，但跨平台实现与硬件证明必须另做验证。首次在线激活、短期签名租约、撤销和换绑政策是实际可交付边界，不应宣传绝对防破解。

## 实施前必须验证的事项

1. 选定 New API 版本的许可与源码提供方式、署名位置，并锁定基线。
2. 账号注册/找回、MFA、封禁和登录撤销在 Nodu 桌面会话上的实际生效。
3. OpenAI/Anthropic 流式、工具调用、usage、错误与取消，逐协议建立合约测试。
4. 多节点同账号并发与余额预占；取消、超时、进程崩溃不能泄漏租约或重复收费。
5. 订阅周期、钱包后备、价格变更和支付回调重复/乱序，不凭前端金额结算。
6. 授权码并发兑换、同硬件重试、复制许可证、换机、撤销及服务故障；原有充值流程不受影响。
7. 云服务只使用获准用于该场景的上游接口，不把个人套餐或订阅转发能力推断为可以向多人销售的授权。

这些是 0.3 的验收工作，不是本次调研已通过的测试。
