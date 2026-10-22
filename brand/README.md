# Nodu · 见微 品牌规范 v2

2026-10-21 · 标志方向 02「点亮」· 主色「电路板」。取代 [v1 蓝色方案](archive/2026-10-19-blue/README.md)。2026-10-22（v2.1）浅色主题由暖白纸面改为纯白。

Nodu · 见微是面向 STM32、K210、ESP32 等主流 MCU 的嵌入式入门学习 IDE。品牌只表达“入门”和“第一次成功”，不绑定任何芯片厂商；具体芯片放在开发板选择里。当前只有 K210（野火 CAM · GC2145）完成真板验证，STM32 与 ESP32 是规划范围，对外文案不能写成已支持。

**从第一行代码，到第一次点亮。**

规范页：在仓库根目录运行 `python3 -m http.server 4190 --bind 127.0.0.1`，打开 <http://127.0.0.1:4190/brand/>。页面可切换深浅主题和色觉模拟，所有色值、对比度与标志都由下文的单一来源生成。

## 单一来源

| 文件 | 作用 |
| --- | --- |
| `src/tokens.cjs` | 全部颜色：核心色、色阶、深浅中性色、状态色、语法与终端色、标志色、对比度目标 |
| `src/geometry.cjs` | 原创矢量几何：点亮标志（常规与小尺寸母版）、nodu 字标、组合与应用图标 |
| `scripts/build.cjs` | 生成 `assets/*.svg`、`tokens.css`、`tokens.json`、`tokens.js` 与 IDE 模块 `desktop/scope-extension/src/browser/nodu-brand.ts`；任一对比度不达标即失败 |
| `scripts/rasterize.cjs` | 用仓库自带的 Electron 导出 PNG、`Nodu.ico`、`Nodu.iconset` 与 `Nodu.icns`（macOS） |
| `desktop/scripts/check-brand.cjs` | 守卫：生成物与来源一致、对比度达标、栅格图不过期、界面源码没有旧色或硬编码品牌色；CI 见 `.github/workflows/brand-check.yml` |

改色或改标志的步骤：

```sh
node brand/scripts/build.cjs
desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron brand/scripts/rasterize.cjs   # 标志或图标有变化时
cd desktop && npm run compile --workspace @scope/studio-extension
node --test scope-extension/test/brand-theme.cjs && npm run check:brand
```

生成的文件不要手改，改 `src/` 后重新生成并一起提交。

## 标志

主标是一颗被点亮的 LED。n 的拱形是灯罩，用点亮黄；两条腿是引脚，左边的长脚为正极，这是初学者装 LED 时会学到的真实细节。灯罩底边平切，与引脚之间留一道间隔，单色使用时仍能读出“灯罩 + 引脚”。

| 用途 | 文件 |
| --- | --- |
| 主标（芯片墨板体） | `assets/mark.svg`；16–32 px 用 `assets/mark-small.svg` |
| 单色主标 | `assets/mark-mono.svg`（`currentColor`） |
| 深色工具栏（不带板体） | `assets/mark-toolbar.svg`（引脚随文字色） |
| 字标 | `assets/wordmark.svg`（单线圆端，`currentColor`） |
| 横向组合 | `assets/logo-on-light.svg` / `logo-on-dark.svg` / `logo.svg`；PNG 见 `logo-on-*.png` |
| 中英组合 | `assets/logo-bilingual-on-light.svg` / `-on-dark.svg` |
| 应用图标 | `assets/app-icon.svg`（Windows / Web）、`app-icon-macos.svg`（1024 画布、824 板体）；`Nodu.icns`、`Nodu.ico`、`app-icon-{16…1024}.png` |

- 灯罩永远是点亮黄 `#FFC23D`，并且永远放在芯片墨 `#14171C` 上：彩色标志自带墨色板体；深色背景上可以去掉板体（工具栏），浅色背景上必须保留板体。
- 横向组合必须带板体。不带板体的灯放在 nodu 旁边，会被读成多出来的字母 n。
- 16–32 px 一律用小尺寸母版（线宽 17.5、间隔 4.5、描边 3 px），48 px 以上用常规母版。
- 板体在深色程序坞上靠 2 px 描边 `#2A2F38`（小尺寸 3 px `#3A404B`）保持轮廓，不另加阴影。
- 单独主标最小 16 px，组合最小 96 px 宽；四周留白不少于灯罩线宽的两倍。
- 不改灯罩颜色（尤其不能用绿色，会被读成“已连接”），不加发光、阴影、渐变或描边特效，不拉伸，不旋转。
- “见微”用思源黑体 SC 设置，印刷或制作位图前转曲；Nodu 正文写作 Nodu，字标固定小写 nodu。

## 色彩

| 名称 | 色值 | 用途 |
| --- | --- | --- |
| Nodu 蓝 | `#2F5BFF` | 主要动作、焦点、选中、进度、活动标记；白字 5.2:1，两套主题共用同一个主按钮 |
| 点亮黄 | `#FFC23D` | 标志灯罩与学习里程碑；只放在芯片墨上（浅底只有 1.5:1） |
| 芯片墨 | `#14171C` | 标志板体、深色工作台、浅底文字 |
| 丝印白 | `#FFFFFF` | 浅色工作台（编辑区、输入框、菜单与浮层）、文档与官网阅读面、深底文字 |

角色色值（链接、焦点、悬停、选中底、中性色阶）以 `src/tokens.cjs` 与 [tokens.css](tokens.css) 为准。深色主题的链接和焦点用 `#8FA8FF`，浅色主题用 `#2449DB`；点亮黄 500 及更深的色阶接近琥珀，只用于印刷和插画。

**浅色主题是纯白。** 编辑区、输入框、菜单与浮层是 `#FFFFFF`；工具栏、侧栏、底部面板与状态栏用冷灰 `#F7F8FA`（token `chrome`），代码块等内嵌区用 `#F0F2F5`，分隔线 `#E0E3E8`。灰阶都取芯片墨的色相（约 218°），所以整体读作白，而不是纸。菜单与浮层（token `overlay`）靠细边和浅阴影浮起，不靠底色。深色主题的 `chrome` 与 `overlay` 都是表面色，不受影响。v2.0 的暖白色值已列入 `legacy`，界面源码里出现会被守卫拦下。

**每个颜色只说一件事：**

- 主色表示“可以操作”：主按钮、焦点环、选中、进度条、活动标记，不做装饰。
- 点亮黄只属于品牌：标志和学习里程碑（例如“第一次点亮”）。不做按钮，不表示警告。
- 琥珀只表示风险：写入 Flash 勿断电、需要确认的操作。
- 绿色只表示成功或已连接。“镜像校验通过”用主色，因为它还没有写入；写入并回读校验后才用绿色。
- 红色只表示错误或停止。用户代码的报错只进控制台，不让设备 chip 变红。
- “连接中 / 进行中”用主色族（深色 `#5F82FF`、浅色 `#2449DB`）加脉冲，不再用琥珀。
- 状态永远同时有文字或图标；规范页的色觉模拟里也要能分辨。
- 代码语法、终端 ANSI、RGB 直方图通道色和样例画面保持自己的含义，不随品牌色替换。

**对比度：** 文字不低于 WCAG 2.x AA 4.5:1，图标、边框、焦点环与大字不低于 3:1。`build.cjs` 与 `check-brand.cjs` 会逐项计算两套主题各 61 组组合，任何一项不达标都会失败。

## 在 IDE 里

- 主题 ID 保持 `scope-dark` / `scope-light`，可见名称为“见微 Nodu · 芯片墨 / 丝印白”。颜色映射在 `desktop/scope-extension/src/browser/nodu-theme-colors.ts`，全部引用生成的 `NODU_COLORS`。
- 自定义面板用 `--theia-scope-*` 变量：`accent`、`accentBackground`、`mutedForeground`、`canvasBackground`、`idle`、`busy`、`ok`、`warn`、`signal`；按钮、焦点、错误等用 Theia 自带变量。不要借用 `terminal.ansiBrightGreen` 之类无关的 ID。
- `desktop/scope-extension/src` 与 `style` 里不写品牌色值；TS 里需要兜底色时引用 `NODU_COLORS`。
- 工具栏左侧：深色主题是不带板体的小灯，浅色主题是小板体（`scope-brand.tsx`，按 `body.theia-light` 切换）。
- 应用图标由 `desktop/scripts/apply-app-icon.cjs`（开发）和 `package-electron.cjs`（打包）读取 `assets/Nodu.icns` / `Nodu.ico`；Electron 窗口底色是深色编辑区色 `#14171C`。

## 来源与许可

标志、字标与全部 SVG 是本仓库原创矢量几何，沿用仓库 MIT 许可；PNG、ICO、ICNS 由 SVG 确定性导出。英文名初筛见 [brand-name-research](../docs/0.1.1/brand-name-research.md)，不构成商标、域名或包名可用性结论。评审过程（三个方向、三套配色、预览页）保留在 [proposals/2026-10-21](proposals/2026-10-21/)。
