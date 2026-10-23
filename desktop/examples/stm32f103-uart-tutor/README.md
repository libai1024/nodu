# STM32F103 串口入门

在 Nodu 中打开此目录，启用教学模式，依次跟写两个代码片段，再保存、编译、下载和观察串口。课程目标为 STM32F103C8T6，内部时钟，USART1 115200 8N1。不依赖指定开发板或板载 LED。

接线：3.3V TTL USB 转串口 RXD 接 PA9，TXD 接 PA10，GND 共地。目标独立供电时不要再接串口模块 VCC。ST-LINK 用 SWDIO/PA13、SWCLK/PA14、GND；确认 F103 后再下载。该课程不自动操作硬件。

起始工程可以编译，但不会发送课程文字。`reference/` 是完成后的参考文件，不参与起始工程构建，也不会自动插入学生文件。编译通过、静态审阅、手动完成和新鲜串口输出是不同的证据。

`.nodu-tutor/plan.json` 为 schema 2 课程，内容摘要由规范JSON计算；sdk-lock.json 的 manifestDigest 是工具包中该SDK文件记录的规范JSON SHA256，不是厂商签名。SDK来源与提交均保留在锁文件中。
