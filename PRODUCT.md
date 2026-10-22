# Nodu · 见微 0.1.2

<!-- impeccable:product-schema 1 -->

## Platform

desktop，目标 Windows / macOS；本版 macOS 已验证，Windows 待实机。

## Stack

Theia 1.76、Electron 42.8、React 19、TypeScript 5.9、Node 24、持久 Python 设备服务。

## Users

嵌入式初学者、学生与创客。

## Product Purpose

面向 STM32、K210、ESP32 等主流 MCU 的嵌入式入门学习 IDE，通过精简的编辑、设备和视觉工作流快速上手嵌入式。K210 为首个目标且是目前唯一完成真板验证的芯片；STM32 / ESP32 与搭芯联动是后续范围。

## Capabilities and Constraints

代码编辑、双布局、REPL、RAM 运行、文件、真实 JPEG 与图像工具已验收。Flash 身份 DE/E7 未通过，不放行烧写。没有正式安装器。UI 不放过程说明，设计理由写注释。

## Brand Commitments

Nodu · 见微，品牌 v2（2026-10-21）：标志方向 02「点亮」（点亮黄灯罩、长脚为正的两条引脚、芯片墨板体），主色 Nodu 蓝 #2F5BFF（「电路板」配色）。规则与单一来源见 [brand/README.md](brand/README.md) 和 [DESIGN.md](DESIGN.md)，由 `desktop/scripts/check-brand.cjs` 校验。v1 蓝色方案（#4F7CFF，小写 n 与独立圆点）已归档。

## Evidence on Hand

本文件为工具兼容入口，版本正文和完整证据索引见 [0.1.2 交接](docs/0.1.2/HANDOFF.md)及 [0.1.1 产品说明](docs/0.1.1/PRODUCT.md)（产品范围未变）。
