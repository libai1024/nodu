# 仓库温湿度监测

固定72MHz裸机教学工程。DHT11测量空气温湿度，SSD1306显示中文读数，USB-TTL输出实际固件JSON；PB0按键翻页，PB15经330Ω限流电阻驱动红色LED告警。

| 端子 | 接线 |
|---|---|
| DHT11 VCC/GND/DATA | 3V3/GND/PB1 |
| OLED VCC/GND/SCL/SDA | 3V3/GND/PB6/PB7 |
| USB-TTL RX/TX/GND | PA9/PA10/GND |
| 按键A/B | PB0/GND，上拉输入 |
| LED支路 | PB15→330Ω→LED A，LED K→GND |

初始24°C、55%RH。温度≥30°C、湿度≥75%RH或传感器读取失败时告警；阈值是教学演示参数，不对应实际仓储安全规范。DHT至少每1.2秒MCU时间采样，模型联仿可能慢于墙钟时间。失败时串口读数为null并在OLED显示异常，不把旧读数作为新结果。

按住PB0超过25ms MCU时间并松开，可在环境页和阈值页之间切换。串口115200 8N1，命令以LF或CRLF结束：`status`、`page`、`threshold 30`、`threshold 35`。发送成功不证明MCU收到，必须查看warehouse_command及后续固件状态。RX/TX接反时不能借内部UART宣称学生串口正常。

示例标题沿用当前教学字库的“温湿度测量”；阈值页使用WAREHOUSE。OLED图像来自固件显存，不使用浏览器文字覆盖。源码和接线独立；改PB1为PB9后须重新构建，接线不自动更改。

在搭芯或 Nodu 中选择“仓库温湿度监测”模板，创建到新的文件夹。生成的 ELF/BIN/HEX 可用于后续仿真或烧录；构建成功不代表仿真或实物行为已经通过验证。
