# Nodu Arduino 仿真包导出证据

范围与使用方式见 [导出文档](../../arduino-esp-sim-package.md)。本目录仅保留可版本化小型证据；完整原始目录、文件大小与 SHA-256 见 `source-manifest.json`。

- 独立 producer 作者实测 23 PASS；最终生产者源由 Study Studio 根 agent 独立复跑 23 PASS。
- 实际服务/RPC 生命周期 17 PASS；辅助 Arduino 回归 88 PASS、2 个明确 SKIP；前端 26 PASS。
- `native-author-01` 为历史 FAIL：C3 真实导出及消费者通过，但初始收起输出时配置错误不可见。
- `native-author-02` 为修复后 S3 原生 8 PASS，含退出重开与持久包校验。

这些结果不等于外设仿真、有线串口、跨应用原生点击或 Windows/Linux 交付通过。首次失败保留，修复后的范围单列。
