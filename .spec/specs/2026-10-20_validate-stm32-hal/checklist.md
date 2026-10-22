# STM32 HAL P0 验收

- [x] 干净独立分支，未携带其他用户改动。
- [x] 范围、硬件条件和未验证事项明确。
- [x] 固定工具和 SDK 来源已记录。
- [x] F103C8 HAL 实际构建通过。
- [x] F407ZG HAL 实际构建通过。
- [ ] F407 ST-LINK 写入读回及运行通过。
- [ ] F103 ST-LINK 实物通过。
- [ ] F103 UART ROM 实物通过。
- [ ] F407 UART ROM 实物通过。
- [x] 证据文档和任务状态一致。

## 验收证据
- 脚本验证：`python3 tools/stm32-p0/validate.py env` 已运行通过，见 evidence/environment.json。
- 构建：`python3 tools/stm32-p0/validate.py build --target f103c8` 与 f407zg 已实际运行通过，BIN 2624/3592 字节。
- 测试：`python3 tools/stm32-p0/selftest.py` 已实际运行通过，五项负样本与两目标最终构建见 evidence/selftest.json。
- 差异边界：`git diff --check` 通过；仅本包、tools/stm32-p0、用户要求的0.2开发文档/导航和专属ignore，主 checkout 未切换。
- 手工验证：F407 已实际读取 ID 0x101f6413、1024 KiB Flash 并保存完整备份及摘要；写入时探针断开，F103/UART 尚无设备枚举。

验收结果：未完成；缺失硬件不得以编译或命令检查替代。
