# Nodu · 见微

品牌规范 v1.0 · 2026-10-19

用户已于 2026-10-19 确认蓝色为正式主色。根目录生产素材与 `assets/blue/` 均为蓝色；暖橙、紫色保留为对照，初版青绿素材归档于 `assets/archive-green/`。

**Nodu** 是面向嵌入式初学者的独立 IDE 品牌。名称用四个字母连接 `node` 与 `do`，建议读作 NOH-doo（诺度）。这是为本产品设计的含义，不是英语词典释义。中文保留「见微」。

**从第一行代码，开始做硬件。**
**Start small. Build real.**

产品方向从 K210 视觉开发扩展到多芯片入门：K210 是首个设备接入目标，STM32F103C8T6、ESP32-C3 / S3 为后续计划。0.1.2 已完成 Theia / Electron 编辑工作区、精简布局修订及 K210 串口、REPL、文件和真实相机；固件容量认证 / 烧写仍被 DE/E7 阻塞，多芯片编译工具链尚未接入。当前交接见 [0.1.2](../docs/0.1.2/HANDOFF.md)。产品是组织编辑、构建与下载流程的 IDE；各芯片的实际编译器属于后续接入的工具链。

## 标志与字标

主标「起点」以小写 n 的入口形态搭配一个独立圆点。开口代表开始，圆点代表第一次点亮的可见结果。它不绑定摄像头、特定芯片或编程语言。

`assets/mark.svg` 是单色主标，`assets/wordmark.svg` 是原创路径绘制的 nodu 字标。二者不依赖安装字体。`assets/logo.svg` 是横向组合；`logo-dark.svg` 用于浅底，`logo-light.svg` 用于深底。所有探索稿均有独立 SVG，主标选用 `exploration-01.svg`。

| 用途 | 文件 |
| --- | --- |
| 可编辑矢量主标 | `assets/mark.svg` |
| 深 / 浅底组合标志 | `assets/logo-dark.svg` / `assets/logo-light.svg` |
| 透明组合标志 PNG | `assets/logo-dark-2040.png` / `assets/logo-light-2040.png` |
| 深色 / 浅蓝应用图标 | `assets/app-icon.svg` / `assets/app-icon-light.svg` |
| 应用图标 PNG | `assets/app-icon-{16,24,32,64,128,256,512,1024}.png` |
| 平台图标 | `assets/Nodu.icns` / `assets/Nodu.ico` |
| 精确矢量品牌展示板 | `assets/identity-board.svg` / `.png` |
| AI 应用概念图 | `assets/nodu-brand-showcase.png`，旁有提示词及来源记录 |
| 六方向与说明 | `assets/explorations.json`、`assets/exploration-01.svg` 至 `06.svg` |
| 下载包 | `assets/brand-kit.zip` |

## 使用约定

- 英文正文写 **Nodu**，图形字标固定小写 **nodu**；完整中文组合写 **Nodu · 见微**。
- 单独主标最小显示 16 px；工具栏建议 24 px。组合标志建议至少 120 px 宽，避免勉强把字标压进小图标。
- 四周至少保留相当于主标圆点直径的空白。应用图标自带平台画布留白，无需叠加第二个圆角外框。
- 保留原始纵横比、n 的断口和独立圆点，不加发光、阴影描边、机械引脚或 Arduino 无限符号。
- 正式品牌蓝为 `#4F7CFF`。石墨 `#181D20` 用于深色工作区，浅蓝 `#8EACFF` 用于深底标志，深蓝 `#244BB0` 用于浅底标志和高对比按钮，柔和蓝 `#E8EEFF` 用于选择底色，暖白 `#F3F3EE` 用于阅读表面。
- UI 中图标可继承 `currentColor`；外部 `<img>` 无法继承父页面颜色，浅深背景应选对应的实体配色文件。

## 正式主色与对照配色

三种配色复用完全相同的主标与字标几何，只改变品牌色及其明暗适配。蓝色应用于实际 IDE 的品牌与交互强调；展示页中的对照切换不会修改桌面 IDE 设置。

| 配色 | 标准品牌色 | 深底标志色 | 浅底 / 按钮深色 | 柔和底色 | 倾向 |
| --- | --- | --- | --- | --- | --- |
| 蓝色，正式主色 | `#4F7CFF` | `#8EACFF` | `#244BB0` | `#E8EEFF` | 清楚、可靠、适合长期使用的开发工具 |
| 暖橙 | `#E98A42` | `#FFB477` | `#9C4B1F` | `#F8E9DC` | 亲切、动手制作、入门教学 |
| 紫色 | `#8B78E6` | `#B6A8FF` | `#5C43A8` | `#EEE9FB` | 年轻、创作、较强辨识度 |

每套素材在 `assets/blue/`、`assets/orange/`、`assets/violet/`，均提供 SVG、透明 PNG、多尺寸应用图标、ICNS 和 ICO。`assets/palette-comparison.png` 是精确矢量导出的三色对比；`scripts/build-palettes.cjs` 为生成来源。浅底文字与按钮使用对应深色，深底标志使用较明亮的适配色，不能把一枚十六进制颜色机械用于所有背景。

## 品牌关系与演进

Nodu 是独立 IDE 的主品牌。「视觉调试」作为一种工作能力保留；K210、STM32、ESP32 进入开发板或平台选择，不进入主 Logo。与搭芯 / DACIR 的项目、设备或仿真协作是后续集成方向，当前不使用“已打通”或“官方附属产品”等说法。

现有工程内部的 `scope-*` 包名、命令 ID 和设置目录作为兼容标识保留。历史 SCOPE 设计图与静态设计网站保留原貌，当前应用可见品牌改为 Nodu。

## 预览、来源与重建

在项目根目录运行 `python3 -m http.server 4190 --bind 127.0.0.1`，打开 `http://127.0.0.1:4190/brand/`。页面可比较三种配色与六个标志方向、切换深浅背景并下载素材。

`scripts/build-assets.cjs` 是 SVG 主资产与 PNG 导出的可复现来源，需要 Node.js 与 sharp。字标、标志和探索稿为本项目原创矢量几何；应用展示概念图使用内置 image_gen，准确生产形状以 SVG 为准。新增源码及原创矢量沿用仓库 MIT 许可。

英文名已作公开网页初筛，发现其他领域同名使用。[命名研究](../docs/brand-name-research.md)记录候选与来源；这里不作商标、域名或包名可用性承诺。
