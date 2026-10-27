# 搭芯代码模板

独立、版本化的 STM32F103C8T6 工程模板仓库，供搭芯（DACIR）和 Nodu 使用。这个仓库不包含两个应用的桌面外壳、账户服务或仿真引擎。

## 模板

| 目录 | 工程 | 主控 |
| --- | --- | --- |
| `templates/temperature-humidity` | 温湿度 OLED | STM32F103C8T6 |
| `templates/warehouse` | 仓库温湿度监测 | STM32F103C8T6 |
| `templates/esp8266` | ESP8266 联网 | STM32F103C8T6，外接 ESP8266 AT 模块 |

使用 HSE 8 MHz / PLL 72 MHz，64 KiB Flash、20 KiB RAM。接线、布局、环境与源码分别保存。不得根据源码自动修正接线，也不能把 F103 的接线和时钟配置直接用于其他芯片。

## 获取与使用

```sh
git clone https://github.com/libai1024/dacir-templates.git
cd dacir-templates
git checkout v0.1.0
npm run check
```

Node.js 20 或更新版本可校验清单，无需安装 npm 依赖。模板目录含完整源码、驱动、电路、布局、初始环境和原始许可；创建工程时复制所需模板，分配新的项目名称与 projectId。已有用户工程不要直接 `git pull` 覆盖。

Nodu 的 Git 同步接入将使用版本锁从本仓库同步数据；现有生成器添加 `nodu.json`、版本来源记录、CMake 适配器和支持文件。产品界面仍只有现有“新建项目”模板选项。搭芯仍作为独立应用使用目录工程；本仓库不提供自动启动搭芯或跨应用运行控制。

`adapter/` 是 Nodu 原生 Arm GCC/CMake 的编译适配，`support/` 保留搭芯的运行时与链接支持。Nodu 编译使用其单独提供的 STM32 HAL/CMSIS 工具包；不声明与搭芯容器编译器产生相同字节或仿真结果。三个模板在初次导出时通过 Nodu 实际编译，仿真与实物行为需独立验收。

## 更新与发布

1. 在分支中修改模板，保留文件许可和驱动来源；不要提交个人项目、密钥、构建产物或账户配置。
2. 检查代码、接线与支持文件的对应关系，然后执行 `npm run reindex` 更新逐文件摘要和内容版本。
3. 执行 `npm run check`；在消费方运行实际编译测试。构建配方、时钟、驱动或接口变化需额外回归，不以摘要校验替代固件测试。
4. 提交并发布新的不可变版本标签，例如 `v0.1.1`。已经发布的标签不移动、不强推。
5. Nodu 更新仓库地址、标签、完整提交 SHA 和内容 SHA 的版本锁，校验并同步后发布。已有工程保留创建时快照，不自动升级或合并。

`manifest.json` 是分发清单，`template-sources.json` 是各模板源码清单。Git 提交固定整个仓库，内容摘要固定模板数据。`manifest.upstream` 保留初次导出时搭芯/驱动来源；后续本仓库的修改由 Git 历史和标签记录，不能假称仍是上游原提交的原样文件。

清单校验不代表编译、仿真或实物验收。此仓库可以独立维护，不要求消费方读取某台电脑上的搭芯源码路径。

## 许可

模板与 NUN_DX 驱动为 **AGPL-3.0-only**，根目录 `LICENSE` 提供该许可证全文。已有文件声明优先，不覆盖第三方许可：Nodu 构建适配与校验脚本为 MIT；适用的搭芯平台支持为 MIT；字形保留 OFL 等原始声明。详见 `licenses/NOTICE.md`、`licenses/` 与各模板 `drivers/nun-dx/licenses/`。

驱动来源与精确提交保存在 `manifest.json`。上游库：<https://gitee.com/yang-changzhi11/NUN_DX_STM32F1c8t6__-open-source-library.git>。本仓库保留相关版权和署名，不将第三方代码改称全部自有。
