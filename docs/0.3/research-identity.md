# 0.3 账号、服务商与设备授权核对

核对日期：2026-10-23。本文件区分官方资料事实与 Nodu 设计建议；未部署服务、未申请商业许可、未实测 TPM / Secure Enclave。仅修改本文，AI 教学实现仍由原开发者推进。

## 1. 结论

沿用主方案的两条路径：官方 AI 使用 Nodu 账号；自定义服务商使用一次性授权码激活当前电脑，账号关联可选。授权码生成、云校验、换绑与撤销放在中转站 fork 中。设备许可证不是 OAuth 登录，也不是上游模型 API Key。

New API 的浏览器账户可以复用为登录身份来源，但不能把浏览器 cookie、后台 token 或上游 key 复制进 Electron。桌面授权服务器、设备许可证和零售计费状态机是需要补做的能力；“网关有用户表”不代表这些能力已经具备。

## 2. ZCode 实际提供了什么

官方配置文档当前说明：欢迎页可连接 BigModel / Z.ai 账号或使用 API Key；会话中的模型选择器底部进入模型管理；第三方服务可配置兼容 OpenAI / Anthropic 的地址、Key、模型，并启用。模型 ID 可以手动添加，不应假设所有服务都支持统一模型列表接口。文档说授权窗口，未公开足以确认其 OAuth/PKCE 内部实现的协议细节，因此 Nodu 不应宣称复制了它的认证实现。[官方配置说明](https://zcode.z.ai/cn/docs/configuration)

该文档还区分 GLM Coding Plan 专用地址与通用余额地址。Nodu 保存 profile 时应保存准确协议与基础地址，不自动改为通用计费端点、不自动切到另一账户或套餐；具体模型以用户权限和实际能力检查为准。[端点说明](https://zcode.z.ai/cn/docs/configuration#bigmodel国内-zai海外api-端点说明)

**设计推论：**借鉴它的入口和服务商配置结构即可，不需要复制套餐商城。Nodu 的一次性硬件授权是自己的产品要求，本次未发现该 ZCode 文档有相同要求，不能写成 ZCode 既有机制。

## 3. LiteLLM 能复用的能力及边界

| 范围 | 官方资料核对 | 对 Nodu 的含义 |
| --- | --- | --- |
| 开源网关 | 基础虚拟 Key、用量跟踪、预算/限速、管理 UI、路由等 | 可作为模型代理基础；不等同于充值、退款和消费账户完整系统 |
| 企业功能 | SSO、SCIM、JWT 认证、审计、委派角色等有企业许可边界；官方当前写明 SSO 至多 5 用户免费 | 不能以“仓库公开”推断这些能力全部可免费使用 |
| 预算 | 官方说明预算依赖数据库，DB-less 部署的全局预算检查存在 fail-open 情况 | 若采用它，预算、故障和并发必须做真实验收，不能只验配置字段 |
| 许可证 | 根 LICENSE 将特定 `enterprise/` 内容与其余 MIT 内容区分 | 按具体发布版本逐文件核对，不笼统写成整个产品都是 MIT |

来源：[企业能力与开源分层](https://docs.litellm.ai/docs/enterprise)、[预算与限速要求](https://docs.litellm.ai/docs/proxy/users)、[根 LICENSE](https://raw.githubusercontent.com/BerriAI/litellm/main/LICENSE)。本次直接访问根 LICENSE 引用的 `enterprise/LICENSE` 路径返回 404，故没有确认该路径的具体商业条款；实施时需锁定选用 tag/commit、实际分发包和许可合同再确认。

**选择建议：**如果目标是内部多模型治理，LiteLLM 很合适；当前目标是已有消费账户、管理后台和中转运营基础，主方案优先 New API 合理。以后确有复杂路由需求，可评估将 LiteLLM 放在内部，但不得形成两套余额、两套并发计数和两套客户主身份。

## 4. 是否引入 Keycloak / authentik

| 项目 | 已核实能力 | 成本与选择 |
| --- | --- | --- |
| Keycloak | 提供完整 OIDC 授权、token、userinfo、JWKS、撤销等标准端点；仓库使用 Apache-2.0 | 适合明确需要统一身份、多个产品 SSO 或企业 IdP 的阶段 |
| authentik | 可作为 OIDC Provider / Relying Party，支持 PKCE、device flow 和 refresh 轮换；核心、企业与文档内容许可不同 | 同样能承担身份，但会增加部署、用户映射和运维面；不能替代设备许可证、模型计费 |

来源：[Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers)、[Keycloak LICENSE](https://raw.githubusercontent.com/keycloak/keycloak/main/LICENSE.txt)、[authentik OAuth](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)、[authentik LICENSE](https://raw.githubusercontent.com/goauthentik/authentik/main/LICENSE)。

**建议：**0.3 不必为了桌面登录强制增加第二套账户库；允许复用中转站账户并增加经过审查的桌面授权模块。但“减少服务数”不是手写 OAuth 的理由：如果选定 Go 库无法可靠完成 public client、PKCE、轮换、撤销和协议测试，应调整为成熟 IdP，而非删减校验。引入 IdP 时以 `(issuer, subject)` 映射内部用户 ID，禁止仅凭可变邮箱自动合并资金账户。

## 5. Electron 原生登录的标准要求

RFC 8252 推荐原生应用使用外部浏览器，public client 采用 PKCE；安装包中的固定 client secret 不能当作机密。桌面 loopback 回调可用随机端口，绑定字面 IP `127.0.0.1` / `[::1]`，只监听 loopback，完成或超时立即关闭。注册路径和实际请求必须严格校验；不能以允许动态端口为由接受任意主机、路径或开放重定向。[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)

Nodu 实施应使用 S256、一次性 code、state、预期 issuer / audience / client 校验；若使用 OIDC 再校验 ID token 与 nonce。公有客户端 refresh token 应采用轮换或发送者约束；密码直接交换 token 不是本方案路线。[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)

Device Authorization Grant 主要面向浏览器或输入受限设备，通过另一设备完成账号授权；它不是把软件授权码永久绑定物理电脑的协议。标准 device flow 需处理轮询间隔、`slow_down`、过期和用户拒绝，可作为以后登录兼容方式。[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)

本机 access token 尽量驻留主进程/Node 服务内存；refresh 和 BYOK key 由 OS 安全存储保存，renderer 只拿状态与不可回读的写入 API。Electron `safeStorage` 是静态数据加密，Windows 下不能防同用户的其他进程，Linux `basic_text` 不是安全凭据库；它不等于硬件不可导出的签名密钥。按项目实际 Electron 版本选择 API，不直接依赖 latest 文档新增接口。[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

## 6. 一次性授权与物理绑定

以下是 Nodu 的设计建议，并非上述网关现成能力：

1. **兑换一次，许可持续。** activation code 只成功兑换一次；license 保存功能和期限；binding 指向电脑和公钥；lease 是短期签名许可。不得每次启动重复消耗授权码。
2. **原子兑换。** 数据库事务对码做条件更新/行锁，绑定和码消耗在同一事务中；同设备同幂等键可恢复结果，不允许两台电脑同时成功。nonce 的消费状态必须覆盖重放与事务重试，签名故障后恢复已提交的结果，不把码退回未兑换。
3. **签名绑定全部关键字段。** challenge proof 至少覆盖服务域、动作、nonce、request ID、设备公钥摘要、硬件摘要版本及请求体摘要，不能仅签一个裸 nonce 后允许替换绑定内容。nonce 短时有效且成功只消费一次，服务端验证 nonce 的预期用途。日志不记录授权码和原始硬件标识。
4. **绑定电脑。** Windows SMBIOS UUID 可作信号，缺失时官方定义为全零；它不是不可伪造的密码。结合平台信号摘要和设备签名私钥，避免用网卡 MAC、IP、用户名或 ST-LINK 作为电脑身份。[微软 UUID 定义](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystemproduct)
5. **硬件保护与硬件证明分开。** Secure Enclave / TPM 内不可导出密钥能提高复制成本；服务器只有验证 attestation 才能确认所声称的硬件属性。没有证明链时，不把客户端上报 `hardwareBacked=true` 当证据。[Apple Secure Enclave](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
6. **不要把 DPoP 当设备认证。** DPoP 可以约束 token 到密钥，减轻 token 被盗后的重放；它不证明密钥位于某块真实硬件，也不阻止被控制的本机进程调用签名功能。[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)

主方案的 24 小时 lease、6 小时周期续期、请求前 15 分钟新鲜度可作为默认建议，但需明确：在线明确收到 revoked/invalid 必须立即拒绝，只有网络不可达等可恢复故障才允许在既有 lease 余期内继续；已撤销状态不能通过断网恢复旧 lease。签名错误、时钟异常和设备不匹配也不能等价为普通离线。

主方案已将 `online_required` 定义为每次模型任务实际出队前重新云校验，不复用 15 分钟缓存。默认离线租约意味着最坏可继续到 24 小时截止，不具备离线实时吊销。所有时长都是产品选择，不是 RFC 规定。

重装保留私钥时可 challenge 恢复；私钥丢失不能仅凭同 UUID 自动认领。免账号许可提供单独恢复凭证或管理员审核；可选绑定账号利于找回。换绑使旧 binding revision 失效，旧授权码仍保持已用。旧机器离线期间仍受旧 lease 的剩余时间约束，不宣称立即消失。

开源桌面客户端本地执行 BYOK 门禁，修改源码的人可以删除检查并直连自己掌握 Key 的供应商。云端能控制自己签发的许可证、官方请求和托管资源，不能让任意被修改客户端绝对服从商业开关。代码签名、短租约、硬件密钥能改善正版发行版的保护；Rust 混淆和隐藏算法不能改变信任边界。

## 7. 主方案复核结果与实施前检查

主方案两路径、密钥不下发、账号/许可证分离、离线撤销边界总体一致。以下规则已纳入方案，实施时需按契约验证：

- 明确 licence 拒绝与网络失败的状态机；收到撤销后不可退回缓存许可。
- 固定 challenge 签名载荷，覆盖完整操作上下文，防不同接口或设备间转用。
- 固定 `online_required` 的新鲜度定义及可对外承诺的撤销时限。
- 本地硬件签名 API 只接受内部可识别的请求结构，不提供任意消息签名 oracle。
- 在最终选定版本逐项测试 PKCE 拦截、错误 state / issuer、refresh 重放、多窗口刷新、并发兑换、超时恢复、重装/换绑、离线到期和凭据库失效。
- 发布前锁定软件版本、源码许可及企业功能合同。本文不替代对具体组合/分发方式的许可证审查。

本轮只进行了官方文档与主设计的交叉核对；未将资料声明升级为产品已经实现或安全认证通过。
