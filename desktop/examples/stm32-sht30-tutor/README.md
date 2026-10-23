# STM32F407 温湿度课程

在 Nodu 中打开此目录，选择教学模式。课程目标为 STM32F407ZGT6，使用内部 HSI 时钟；不要求指定开发板、板载LED或蜂鸣器。报警通过串口状态表示。

课程选用 USART1 PA9/TX、PA10/RX，115200 8N1；I2C1 PB6/SCL、PB7/SDA，SHT30 ADDR接GND（0x44）。传感器使用3.3V并共地，SCL/SDA需上拉到3.3V；目标与器件模块的供电、电平和接线必须由用户确认。仅验证过离线构建及纯函数测试，本次未连接或烧录F407，未验证传感器通信。

`Support/tutor_target.c` 提供时钟与引脚初始化。`Support/starter.c` 的弱定义只让尚未完成的课程能链接；空实现不代表完成，缺失总线驱动返回错误。学生在 app、bsp、drivers 写出的普通定义会替代对应弱定义。`reference/` 是完整参考源码，不参与起始构建。课程的“完成”属于用户自查，编译与硬件验证仍需各自证据。

纯函数测试的 starter 没有断言时退出码为2，不能误报全部通过。参考测试覆盖CRC、换算及报警迟滞，可用 `desktop/scripts/test-tutor-courses.cjs` 从仓库运行。WASI产品执行尚在单独开发，宿主测试不能当作WASI验收。

课程schema已更新为2，旧schema1仅保留在解析器测试fixture。sdk-lock.json记录工具包SDK文件清单摘要及上游提交；源码的ST许可声明保留。

资料：[ST STM32F407文档](https://www.st.com/en/microcontrollers-microprocessors/stm32f407-417/documentation.html)、[Sensirion SHT3x-DIS 数据手册](https://admin.sensirion.com/media/documents/213E6A3B/63A5A569/Datasheet_SHT3x_DIS.pdf)。CRC多项式0x31、初值0xFF，示例BEEF得到92；换算使用16位原始数值。完整测试不能证明真实传感器已连接。
