# 0.2.3 本地整合与候选包验收

日期：2026-10-29。完整跨平台发行未完成；本轮已生成并验证 Windows STM32 便携包和安装器，其他目标的失败原因保留在记录中。

## 源码与分支

`main` 包含原 `codex/dacir-link` 的已提交历史。其工作区未提交内容通过 `fc5de10d` 快照纳入 `1d09eb2` 合并提交，原工作区文件保持原样。Keil、DACIR、ESP 仿真导出、Windows 安装器及串口修复均已整合。

候选安装包源码身份为 `425a2e600b6d93464bf354babd0541f1494424b1`，两份 manifest 均为 `sourceDirty=false`。后续主线提交仅增加发布说明、校验信息和验收证据，不改动这两份安装包的源码身份。[分支快照](branches.json)

## 检查

- [Node 24 回归](node24-tests.log)：144 项，143 通过，1 项独立仿真集成按条件跳过，0 失败。
- TypeScript `tsc --noEmit` 通过。
- [原生服务](native-tests.log)：48 项通过。
- [便携目录验收](windows-portable-acceptance/clean-package-acceptance.json)：真实工具链编译、语言功能和后台启动通过。
- [安装器验收](windows-build/installer-acceptance.json)：静默安装到 D 盘成功，驱动步骤返回 0，原卸载登记已恢复。
- [安装后验收](windows-installed-acceptance/clean-package-acceptance.json)：再次完成编译、语言功能和后台启动检查。

两个包目录分别验证五个成功的 F103 编译用例、故意错误及恢复、clangd 补全/定义/诊断。环境 PATH 只保留 Windows 系统目录，程序和工具的外网访问通过临时 WFP 规则限制；测试后移除规则。没有请求烧写硬件。

构建、工具、工程和安装目标均在 D 盘。Windows 构建使用既有 E 盘 Node 24.12.0；通用 manifest 的 Node 24.21.0 配置字段并非该主机的实际版本。未安装到 C 盘的应用目录；Windows 驱动由操作系统管理其系统目录。

## 文件与未完成目标

ZIP 及 EXE 的大小、SHA-256 和提交身份见[发布说明](../../releases/0.2.3.md)、[ZIP 清单](Nodu-0.2.3-stm32-win32-x64.manifest.json)、[安装器清单](Nodu-0.2.3-stm32-win32-x64-setup.manifest.json)。下载回本机后重新计算，两份文件与清单一致。

- [Windows 完整版失败记录](windows-build/full-package-stderr.txt)：20 项 Arduino 对应材料覆盖未完成，默认发布校验拒绝。
- [Mac arm64 失败记录](package-mac-arm64.log)：本机没有正式发布用 STM32 工具包；当前本地工具包是 dev profile，不能替代。
- [Mac x64 失败记录](package-mac-x64.log)：缺少对应 WASI 工具输入，后续 Arduino 离线输入也未满足。
- Linux 尚没有应用打包目标。

没有放宽发布校验、没有将旧包改名，也没有把 Windows STM32 专用包当作 Arduino 完整版。完整发行条件未满足，因此候选文件上传 GitHub Release 草稿，最新正式版仍保持 0.2.2。
