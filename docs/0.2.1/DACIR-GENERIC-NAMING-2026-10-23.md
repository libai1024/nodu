# DACIR 模板通用命名调整

日期：2026-10-23。用户要求移除目录、文件抬头和函数名中的 DX / NUN_DX 专属前缀。改动范围为 `/Users/wangwei/Model/dacir-templates` 的三个待发布模板，以及搭芯目录工程构建器的新旧布局兼容。没有改名现有用户工程，没有替换 Nodu 正在使用的内置模板快照，未修改搭芯的独立上游驱动仓库。未创建远程仓库或上传。

## 命名结果

```text
drivers/embedded/
├── common/
│   ├── embedded.h
│   ├── types.h
│   ├── driver_config.h
│   ├── fifo.c / fifo.h
│   ├── font.c / font.h
│   ├── font16.c / font16.h
│   └── interrupts.c / interrupts.h
├── peripherals/    # gpio、uart、i2c、spi、adc、delay、timer 等
├── devices/        # ssd1306、mpu6050、aht10、esp8266 等
├── control/        # pid.c / pid.h
├── debug/          # debug.c / debug.h
├── licenses/
├── LICENSE
└── upstream.lock.json
```

| 原名 | 新名 |
| --- | --- |
| `DX_driver_gpio.h` | `peripherals/gpio.h` |
| `DX_common_headfile.h` | `common/embedded.h` |
| `DX_common_typedef.h` | `common/types.h` |
| `DX_device_0.9_i2c_oled.h` | `devices/ssd1306.h` |
| `DX_device_i2c_mpu6050.h` | `devices/mpu6050.h` |
| `DX_GPIO_Init` | `gpio_init` |
| `DX_GPIO_SetHigh` / `DX_GPIO_SetLow` | `gpio_set_high` / `gpio_set_low` |
| `DX_GPIO_Read` / `DX_GPIO_Toggle` | `gpio_read` / `gpio_toggle` |
| `DX_Delay_Init` | `delay_init` |
| `DX_Delay_us` / `DX_Delay_ms` | `delay_wait_us` / `delay_wait_ms` |
| `DX_assert` / `DX_log` | `debug_assert` / `debug_log` |
| `dx_font16_find` / `dx_utf8_next` | `font16_find` / `utf8_next` |
| `DX_USE_OLED` | `DEVICE_ENABLE_OLED` |
| `DX_OUTPUT_PP` | `GPIO_OUTPUT_PP` |
| `__DX_DRIVER_GPIO_H` | `EMBEDDED_PERIPHERALS_GPIO_H` |

每个模板迁移 63 个库文件，共涉及 75 个标识符；更新 `@file`、include、功能配置、类型、全局变量、调用与 CMake 路径。`delay_wait_us` 避免与应用内部已有的 `delay_us` 静态函数冲突。已有 `uart_init`、`esp8266_init` 等通用接口保留原名；不增加旧名称兼容宏。许可证文件名统一为 `licenses/AGPL-3.0.txt`，内容未变。

原始作者、版权和许可文本仍保留。来源锁中的历史仓库地址、提交及旧目录记录用于追溯，不是当前代码标识符。名称变更不表示代码改为 DACIR 原创。前次“完全无第三方署名”的发布要求仍未满足，未自动解除上传暂停。

## 构建兼容

独立模板的 `adapter/CMakeLists.txt` 使用 `drivers/embedded` 布局，编译公共模块、外设、器件及原始平台支持。

搭芯 `/Users/wangwei/Project/FC/STM32_Study_Studio/firmware/directory_build.py` 原本只识别旧目录，会把新目录当作普通应用源码并回退到旧库。本次增加新布局识别，保持旧布局行为；新库缺少必要公共文件、同时出现两种库目录时明确拒绝。新模板构建记录的来源必须为 `project-snapshot` / `drivers/embedded`，不允许悄悄使用上游备用库。旧项目继续从自己的旧布局快照构建。

增加 3 项回归用例，覆盖不回退、不重复编译、缺失新库与双目录冲突；原有 7 项用例继续通过。Nodu 的已审查构建器摘要锁同步更新为 `f0a3ea2867f36bde14c567881d1af299f4935b08011a568e637df78c112fe4ac`。这只更新构建器审查锁，未把当前模板内容写入旧的内置资源。

## 验证结果

- 清单校验通过：`snapshot-ea97381227a91aa4`，258 个分发文件。
- 三套模板的 C 源码和头文件中，旧 DX / dx / NUN_DX 标识符为 0；本地头文件引用全部解析；每套 33 个头文件保护宏互不冲突。
- 206 个代码文件逐一进行去注释后的词法对照：除声明的名称/引用替换外，代码 token 保持一致。
- 原始库许可证、字体通知、字体来源锁逐字节一致。
- Nodu 真实生成/编译：温湿度、仓库、ESP8266 三套均通过；ELF/BIN/HEX/MAP/compile_commands.json 检查及构建过期验证通过，报告含父测试 4/4。
- 搭芯容器构建：三套新目录与三套原始旧目录，共 6/6 通过；ELF/BIN/HEX 一致性、Flash/RAM 边界通过。
- 目录构建器回归：10/10 通过。
- 三套改名前后 BIN 大小分别为 20296、21588、11364 字节，RAM 预留分别为 3920、4528、6168 字节，与旧模板一致。
- 改名与目录调整改变对象文件排列，BIN/HEX/ELF 摘要不相同，不能宣称二进制完全相同。核对每套 67 个向量表项，发生重定位的项仍映射到相同处理函数名称；未改变向量对应关系。
- 本轮未运行双仿真引擎或桌面交互验收，未烧录、复位或连接串口；不能把编译验证描述为仿真/实物功能全部验证。

证据位于 `docs/0.2.1/evidence/`：

- `2026-10-23-dacir-generic-naming.json`
- `2026-10-23-dacir-generic-naming-builds.tap`
- `2026-10-23-dacir-directory-layout-tests.txt`
- `2026-10-23-dacir-generic-binary-comparison.json`
- `2026-10-23-dacir-vector-comparison.json`

完整映射与改名前备份在 `artifacts/dacir-preupload-20261023/`，不随独立模板仓库发布。容器构建产物与日志在该目录的 `dacir-builds/`。
