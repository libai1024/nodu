# Nodu 主线与工作区收拢记录

日期：2026-10-27。

## 范围与最终本地结构

审计本仓库的 12 个本地分支、7 个 Git 工作区、远端分支、暂存区、未提交文件及恢复对象。保留唯一代码目录 `/Users/wangwei/Model/k210-studio`，使用 `main`。其余 6 个工作区和 11 个本地分支已清理；历史版本标签、reflog 和 Codex 恢复 refs 保留，没有执行过期清理或对象裁剪。

所有旧分支的已提交历史原本均已被 `codex/nodu-02-integration@ba63cd6` 包含，没有遗漏的独立分支提交。原 `main@de67821` 落后该集成线 17 个提交，采用快进方式保留原提交历史。

| 原工作区 | 未提交内容的处理 |
| --- | --- |
| nodu-02-integration | ESP32 Arduino、串口、AI 引用、新建项目界面、固定版离线环境及验收成果提交入主线 |
| k210-studio-v0.3-plan | 13 份账号授权规划、协议及测试文件保留入主线；仍是规划和契约，不表示 0.3 功能已完成 |
| start-window | 旧启动台的大部分功能已在主线演进；仅移植尚缺的“最近项目逐项跳过失效目录”逻辑，增加 4 项测试；原始差异完整归档 |
| composer-ui | 没有独有源码，仅本机资源符号链接；归档后清理 |
| stm32-hal-validation | 已提交代码全部在主线；原始 Flash 备份、验证材料与本机工具归档 |
| terminal-ui-design | 已提交代码全部在主线；旧运行资源归档 |
| 原主目录 | 2 篇研究文档及 743 份经筛选的 Nodu 验收输入、报告、截图和结果纳入主线；重复草稿和个人主题偏好归档 |

按用户选择，独立物联网小程序、演示视频、ESP32 洗手台硬件素材和旧独立预览项目保留在仓库外，不加入 Nodu 主线。旧第三方 clone、设备备份、运行状态和构建产物也保留在本机归档中。

## 本机恢复归档

归档目录：`/Users/wangwei/Model/nodu-consolidation-backup-20261027-100612`。

- `README.md`：恢复方法与各快照对应关系。
- `git-recovery/`：收拢前的完整 Git 对象、refs、reflog 和恢复记录，`git fsck --full --no-reflogs` 通过。
- `worktrees/`、`state/`：7 个工作区快照、工作区/暂存区二进制补丁、未跟踪文件和忽略资产清单。排除可再生的 node_modules、Rust target 等缓存。
- `independent/`：独立小程序、硬件素材和旧 preview 的原件。
- `original-local-files/`：原目录中的完整本地材料；主线只收录筛选后的 Nodu 内容。
- `verification/`：本轮首次失败、定点复验与最终通过日志，附 SHA-256 清单。

STM32 原始 Flash 备份 `f407-before-p0.bin` 已核对为 1 MiB，SHA-256 为 `5d94950ba7e1708599cee9f111df6b49b0a4bf06b51fae8b39dac85dc49b62e9`。删除前，其他工作区的未提交补丁和未跟踪文件均与快照复核一致。

## 运行资源迁移

保留主目录自身的 node_modules 与 STM32 工具，不复制集成工作区指向主目录的反向链接。新增 Arduino 构建输入、离线包、语言工具、`resources/bin`、`resources/wasi` 和 Arduino 编辑器插件已迁回主目录；相关目录没有指向被删除工作区的符号链接。主目录已重新生成扩展和 Electron 构建产物。

这些本机资源仍按原规则忽略，不加入源码 Git 历史。Arduino 离线发布包与对应源码材料的既有发布限制仍适用，本次分支收拢不代表生成了新的正式安装包。

## 验证

- 主目录扩展 TypeScript 编译、Electron frontend/node/electron 构建：通过，0 个构建错误。
- `node --test --test-concurrency=4 scope-extension/test/*.cjs scripts/*.test.cjs`：994 项，992 通过、0 失败、2 项按外部上游条件跳过；包括本机真实 STM32 工具链流程。
- `cargo test --manifest-path desktop/native/Cargo.toml -p nodu-embedded --lib`：45/45 通过。
- 新保留的 license contract：20/20 通过，亦包含在上述完整 Node 测试中。
- 源码与提交的 whitespace 检查通过；冻结验收原始输出用 Git attributes 保持原始字节，不改写哈希证据。

初次整合测试发现一个旧 STM32 测试 fixture 未经过首次工作区检测，却假设已位于该工作区；现改为真实初始化后检查同路径变更，保留原断言，并增加切换工作区清空旧状态的对照用例。运行实现无需修改。

资源迁移后首次 WASI 探测在时限内未确认工具版本；直接核对固定工具版本后，定点测试与完整测试均通过。原失败日志保留，没有放宽产品执行时限或跳过该测试。
