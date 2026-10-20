# 认识开发板：实现与验证记录

2026-10-19。task-board-guide（task12）验证证据。引脚事实来源见
[board-source-audit.md](board-source-audit.md)；本记录只覆盖实现与验证。

## 实现范围

- `common/nodu-board-info.ts`：纯解析器 `inspectBoardConfig(text)`，16 KiB UTF-8
  上限、顶层 JSON 对象、别名白名单（0–47 整数 IO）、`pin_num`/`pin_name`/`D`
  元数据、`__proto__` 等危险名拒绝；状态 `declared|unknown|missing|invalid|
  conflict|unavailable` 语义与冻结定义一致。
- `NoduDeviceService.inspectBoard()`：Node 后端经既有 `listFiles`/`readFile`
  读取 `/flash/config.json`，连接纪元与端口双围栏；RPC 门面 allowlist 已加
  `inspectBoard`。不写板、不探测硬件。
- `NoduDeviceModel`：`boardInspection`/`boardInspecting` + 代际守卫；端口变化、
  连接中、断开、错误、复位、服务断开即清除；连接成功后自动读取一次；`boardLabel`
  仅在 `declared` 匹配时给目录名，否则 `K210 · 未识别`/`选择开发板`。
- `NoduBoardWidget`（`nodu:board-guide`，主区）+ `scope.board-guide` 命令
  （见微 → 认识开发板）+ 设备浮层「认识开发板」按钮；面板标签改为
  「相机适配」「连接复位方式」，不再把复位/适配当成识别身份。
- `tools/boards/build_embedfire.py` + `models/embedfire-cam.{blend,glb}` +
  `resources/boards/embedfire-cam-{top,angled}.png`（960×720 RGBA 透明背景）。
- `desktop/examples/board-api/nodu_board.py` + README + 7 项 stdlib 测试。

## 自动测试

| 命令 | 结果 |
| --- | --- |
| `npm run compile --workspace @scope/studio-extension` | 0 errors |
| `node --test scope-extension/test/board-info.cjs` | 11/11（declared×2 / unknown / conflict / invalid×3 / 元数据+D 形状 / D 双向冲突 / 畸形标识符与外设 → invalid / 16KiB / `boardPinSample`） |
| `node --test --test-name-pattern='board inspection' scope-extension/test/backend-validation.cjs` | 7/7（未连接/运行/忙→unavailable 且不发请求、missing、超限或目录→invalid 不读文件、真实 config → declared、跨 await 断连 → stale、畸形 base64/size → invalid、读取后断连 → unavailable） |
| `python3 -m unittest discover -s examples/board-api -p 'test_*.py'` | 11/11（别名/D0 往返/冲突与元数据校验/深拷贝/非字符串与非法名/生成代码段可执行/无 re 依赖导入） |
| `npm run build:electron` | 0 errors（含 native/imaging） |
| `impeccable detect`（widget/panel/css） | 静态规则无发现；页面级规则需运行时页面 |

## 端到端（隔离 Electron，`NODU_DEVICE_MOCK=1`，无真实硬件）

启动：`Electron /tmp/nodu-board-guide-app --remote-debugging-port=4197`，
`userData=/tmp/nodu-board-guide-user`，工作区 `/tmp/nodu-board-guide-ws`。

- 连接 mock 口 → connect 回调自动触发 inspectBoard → 真实 `missing`
  （mock /flash 无 config.json）。断开即清除。
- mock 板写入 `/flash/config.json`（野火快照）→ `inspectBoard()` →
  `declared` / `boardId=embedfire-cam-gc2145` / pins `{USER_LED:17,BOOT_KEY:16}` /
  peripherals `sensor,lcd,sdcard`；工具栏 chip 显示「野火 K210 CAM」。

## UI 验证（CDP 注入，注入状态已标注；模型经 `window.theia.container` 解析，无生产全局句柄）

截图见 `artifacts/board-guide/20261019/`（复审轮重新捕获，设备浮层已由
contribution 主动关闭、无遮挡）：

| 文件 | 内容 |
| --- | --- |
| 01-disconnected-guide | 未连接态 1520×960：紧凑头部（状态+目录选择+读取按钮），无浮层遮挡 |
| 02-browse-bit-offline | 离线浏览 Maix Bit 参考引脚 |
| 03-declared-embedfire-top | 注入 declared：双栏工作区（左模型+编号标记/图例，右引脚表） |
| 04-header1-contacts | 标记 8 → 部件详情内触点表（14 行 × 4 列，触点/功能成对） |
| 05-contact-sample | 触点 IO36 → 只读示例 `io = 36 / print(io)`，无 fm.register |
| 06-search-empty-peripheral | 无匹配搜索保留输入框；仅外设配置仍显示表格 |
| 07-angled-view | 斜视渲染 |
| 08-light-declared-1520 | 浅色主题 1520×960 |
| 09-light-980x680 / 10-dark-980x680 | 980×680 浅/深（主题经 ThemeService 实测切换） |
| 11-dark-declared-1520 | 深色主题 1520×960 |
| 12-dark-connector-table | 终审轮复拍：深色下电源/接地触点标签高对比 |
| 13-light-980-final | 终审轮复拍：浅色 980×680 确认 |

另验证（复审轮新增）：待决读取中断开/换口 → 过期结果丢弃且不残留
`boardInspecting`；别名行 → `nodu_board.pin("…")` 统一助手示例（含上传提示）；
外设行 → `config.get_value("sensor", {})["pin_clk"]`；D 展开别名 D0 走同一助手；
电源/接地触点无代码示例；Tab 键可达「读取板端配置」；命令注册可检索；
断开后 chip 回「选择开发板」且 inspection 清除。

## 资产

- `tools/boards/models/embedfire-cam.blend` sha256 `7f744e9c193865d7e886bbfe0af3d8bc4e3fe61acd8960a4e458381984b8216d`
- `tools/boards/models/embedfire-cam.glb` sha256 `e3fad7aad6fa24d518d27abfc1f72e4e96aab7cff6a788f9b6a72d0ebdb81e00`
- `resources/boards/embedfire-cam-top.png` sha256 `2a54ba6c633da9a19aee7c455bbd3b89ed6e3f9db9aed3af5acec635505f3ea1`
- `resources/boards/embedfire-cam-angled.png` sha256 `c3d99f0fd9000a56b9710c74ecc590711bb1faceebe2bf13955a4d79cca3df13`
- `tools/boards/build_embedfire.py` sha256 `9732dc21fc157e493c205c64c9d13db3a0ff070021872fcb276e92e640787326`
- 渲染：Cycles 64 采样（EEVEE 在本场景不输出透明底）；相机参数与俯视
  标记坐标一致（ortho 横向 10.8 × 纵向 8.1 单位）。复审轮几何修正：
  按键移到右上、microSD 下移避让、排针改为母座（金环+暗孔）；
  `save_version=0` 不再产生 .blend1 备份。模型为教学示意，非机械 CAD，
  不标注触点方向。

## 差异归因

工作树在本任务前已有大量未提交修改。预存基线 diff
（`/tmp/nodu-task12-baseline.diff`，约 3750 行）已逐文件应用到 HEAD 检出副本
（`/tmp/nodu-base-wt`），再与当前工作树逐文件对比，得到仅含本任务改动的
`artifacts/board-guide/20261019/task12-tracked-files.diff`（12 个既有文件的增量；
新增文件由 `git status` 未跟踪清单给出）。不覆盖、不回退任何预存修改。
注意：`THIRD-PARTY-NOTICES.md` 段落中「Bundled FFmpeg media tools」一节是
任务期间并行到达的用户改动（基线快照之后才出现），不属于本任务范围；
本任务在该文件的改动仅为 `nodu-board-data.ts` 引脚转录来源一段。

## 复审修正记录（2026-10-19 第二轮）

- 解析器：畸形标识符/外设字段/双向 D 冲突现在整体判 invalid，不再带病
  declared；`pin_num`/`pin_name`/D 长度做形状校验。
- 后端：`readFile` 响应先做 base64 字母表/长度/声明 size 校验，并与目录
  size 比对，读取期间文件变化 → unavailable。
- 前端：移除 `window.__noduDevice` 生产句柄；`onState` 记录 previousPort，
  任意换口即失效；`disconnect()` 入口即清；live 详情随 inspection 失效。
- 代码段：触点只读 `io=N/print(io)`；外设走 `Maix.config.get_value`；别名
  统一 `nodu_board.pin()`，附上传前提；电源触点无代码。
- UI：打开向导前关闭设备浮层；≥850px 双栏（container query）；标记常显
  + 图例按钮；触点表改为 14×4/3×4 逻辑行；空搜索保留输入框。
- Python：`pin()` 走校验后的 `pins()`（D0 可解析、别名一致）；`peripheral()`
  递归拷贝；`info()` 标明 `Maix.config runtime cache` 为实际读取路径。
- Blender：按键右上、microSD 下移、排针母座化；不再生成 .blend1。

## 终审修正记录（2026-10-19 第三轮）

- helper：移除 `import re`/`ure` 依赖（MicroPython ure 无 `{m,n}` 量词），
  字符级 `_valid_name`；新增阻断 re/ure 导入仍可用测试与空/超长/换行/
  非 ASCII/保留名用例。未经真实板验证，仅声明固件兼容意图。
- 解析器：`pins`/`peripherals` 仅在全部校验通过后一次赋值；合法 sensor
  后接畸形 lcd → invalid 且两表为空（新增断言）。
- 前端：触点电源标签去 orange 低对比改用前景色加粗；触点表
  min-width 280px / width min(100%,420px) / 12px；footer 修正
  `p>details` 非法嵌套为 `.nodu-source-line` div。
- 目录选择：`catalogManuallySelected` + `lastInspection`——未手动选择时
  跟随最新 declared（连接前打开也能更新），手动浏览永不被事件覆盖，
  live 详情随 inspection 失效。CDP 实测：断连打开 → 注入 declared 自动
  选野火；手动 Bit → 再注入 declared 保持 Bit。
- 终审验证：compile 0 errors、board-info 11/11、helper 11/11（后端未改
  未重跑）；`node esbuild.mjs` 前端 3/3 0 errors；4197 重载后捕获
  12/13 两张确认截图；预览恢复断连/离线/野火视图。task12 经主线程
  终审标记完成，旧固件任务保持开放。

## 已知边界

- 测试经 `window.theia.container` 获取模型（Theia 生成的引导器本就暴露
  container），生产代码不新增全局。
- 菜单项注册路径与既有命令一致；原生菜单栏截图不含页面内 DOM，命令经
  命令面板与浮层按钮实测可达。
- Windows 未实机验证；mock 板只覆盖 missing/declared 两态，其余状态由
  单元测试与注入覆盖。
- 真机验收（/dev/cu.usbserial-3120，MaixPy 0.6.3，标准 UI 连接路径）：
  真板配置读取与 UI 通过；helper RAM 执行带预导入成功，首次失败原因及
  常规模块安装待验证。详见 `board-guide-hardware.md` 与
  `artifacts/board-guide/20261020-hardware/`。
