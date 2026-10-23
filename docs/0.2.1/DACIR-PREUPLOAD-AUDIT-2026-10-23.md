# dacir-templates 上传前检查

日期：2026-10-23。范围：`/Users/wangwei/Model/dacir-templates` 的独立模板分发目录，不是 Nodu 或搭芯整个应用仓库。当前未创建远程仓库、未提交、未上传。用户要求不保留第三方作者署名；剩余实际依赖仍有原始署名，因此当前发布暂停，不能视为满足该要求。

## 上游依赖

| 内容 | 当前来源与状态 | 是否能只删署名解决 |
| --- | --- | --- |
| NUN_DX 驱动 | 三个模板均包含驱动副本。基础版本 `55b44abeee127e0326ac8a5258f4c0f4df6dc2a5`，上游为 `https://gitee.com/yang-changzhi11/NUN_DX_STM32F1c8t6__-open-source-library.git`，原提交 `1c6ce771d3f1bc943774c563be059d6255e27147`；库声明 AGPL-3.0-only，存在 YCZ 等作者署名。 | 不行；去掉文字不会改变代码来源。若要求完全不含其署名，应替换实际使用的实现，并重新验证。 |
| 字形 | DX Teaching 16 子集来自 GNU Unifont 16.0.04；字形声明 OFL-1.1，查表和 UTF-8 代码另有 AGPL 声明。原始作者与许可保存在源码和通知中。 | 不能以删除版权声明代替替换字形。 |
| ST HAL/CMSIS | 不在模板包内；CMake 从 Nodu 的 STM32 工具包加载 HAL、CMSIS、设备支持与启动汇编。 | 模板仍有构建依赖；本次没有改动该 SDK 或其许可。 |
| 构建工具 | Arm GCC、CMake，Nodu 负责提供；模板校验脚本只需 Node.js 标准库。 | 与模板作者留言不同，不能宣称完全无外部依赖。 |
| ESP8266 教学服务 | `tools/network_fixture.py` 使用 Python 标准库，手动启动 TCP/MQTT 服务；模板校验、创建不自动启动服务。 | 保留功能边界，不涉及自动下载上游代码。 |
| 搭芯支持文件 | 运行时、链接脚本、时间基准与支持头文件来自搭芯源项目；按原目录分别保留 MIT/AGPL 声明。历史名称 STM32 Study Studio contributors 出现在部分版权声明中。 | 历史版权名称不能直接当成无关调试留言改写。 |

独立模板的校验和 CMake 适配不会在构建时自动拉取上游 Git、npm 或 pip 依赖。驱动是锁定副本，ST 工具包需事先具备。模板不依赖本机搭芯主仓库的绝对路径；仿真仍由搭芯应用提供。

## 发现和处理

1. 三份 `DX_device_zdt_emm_v5.c/.h` 含厂商作者、店铺、博客和 QQ 群信息，且注明从厂商例程移植。未找到该例程的单独许可说明；不能据此断言已获得全部再分发权。确认三个应用均未启用、未调用此驱动后，从待发布包剔除共 6 个文件，以及配置和公共头中的对应入口。没有抹掉名字后继续分发该实现。
2. `components.lock.json` 增加分发裁剪记录和日期，保留上游基础提交；`template-sources.json` 与包清单重新生成，避免将裁剪后的内容描述成上游原样文件。
3. 仓库模板 README 清理“本轮”“证据目录”等内部开发叙述。ESP8266 README 改为独立模板实际存在的 `tools/network_fixture.py` 路径，去掉未分发的构建和测试脚本命令。
4. 字体 NOTICE 引用了缺失的 `upstream.lock.json`，已从原驱动库 `fonts/upstream.lock.json` 原样补齐到三份模板；验证其中四个许可/通知文件的摘要全部匹配。锁内字体原文件路径是上游包元数据，不表示本包包含整个字体源包。源码头部原有 `fonts/licenses` 引用仍属于上游布局，本包对应文件在 `drivers/nun-dx/licenses`，字体通知和锁可用于追溯。
5. 原作者与版权声明仍保留在实际使用的驱动、字库和许可文件中。没有改署 DACIR，也没有宣称全部代码为 DACIR 原创。
6. ESP8266 的 `Studio-Lab` / `studio123` 是随教学模板公开的示例配置；MQTT 主题和 client ID 是协议示例值，未作为“品牌痕迹”擅自修改，以免破坏配套服务行为。没有发现真实凭据的证据；模式扫描不能证明不存在所有类型的秘密。

## 验证

- 检查 264 个文件，其中分发清单覆盖 258 个文件；无符号链接。
- Claude、ChatGPT、Codex、Gemini、DeepSeek、OpenAI、Anthropic、共同作者尾注模式：无匹配。
- 本机用户路径和本机身份模式：无匹配。
- 店铺、QQ群、CSDN、原电机厂商推广模式：清理后无匹配。
- 常见 GitHub/API token、AWS key 与私钥头模式：无匹配；人工检查示例密码用途。
- 补齐的字体锁与许可摘要：通过。
- `node scripts/manifest.cjs --check`：通过；包版本 `snapshot-43a47e60ae334a9e`。
- 使用 Nodu 真实生成器读取独立目录，再通过隔离 sidecar 编译：温湿度、仓库、ESP8266 三套均通过（含父测试 4/4，0 跳过）。检查 ELF/BIN/HEX/MAP/compile_commands.json 非空、BIN 容量限制、修改源码后构建状态过期。
- 测试 RPC 白名单仅为 openProject、trustProject、build；没有连接串口、烧录、复位或操作板子。
- 仅修改独立待发布目录。未替换 Nodu 当前内置快照、未修改搭芯源仓库和现有用户工程。

证据：`evidence/2026-10-23-dacir-preupload.json`（修改前摘要、修改/删除列表与扫描结果），`evidence/2026-10-23-dacir-preupload-builds.tap`（真实构建结果）。

## 尚未完成

当前不满足“完全无第三方署名”：NUN_DX、字库和外部 ST SDK 仍是实际依赖。满足这一要求需要独立实现所需驱动/字形，或选用许可允许不展示作者署名的替代品，并重新核对各替代品的分发条件、编译与仿真行为；不能通过清空文件头实现。

GitHub 仓库创建、首个版本发布和 Nodu 的远程 Git 同步接入仍未完成，不应把 README 中的接入方案当作已上线能力。待署名/依赖范围解决后继续发布与同步，不向公众发布当前尚不符合用户要求的快照。
