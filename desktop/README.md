# Nodu 0.1.1 开发入口

完整说明已按版本归入 [开发与启动](../docs/0.1.1/GETTING_STARTED.md)。接手先读 [0.1.1 交接](../docs/0.1.1/HANDOFF.md)。

使用 Node.js 24，在当前目录执行：

```sh
npm ci
npm exec -- install-electron
npm run setup:device
npm run build:electron
npm run start:electron
```

浏览器使用 `build:browser` / `start:browser`。切换目标涉及原生依赖 ABI 重建，现有窗口与未保存文件须先保留。当前固件身份 `DE/E7` 未通过，烧写仍被阻止。
