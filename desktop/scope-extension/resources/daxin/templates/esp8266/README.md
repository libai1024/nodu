# ESP8266 八针 AT 模块：真实 TCP / MQTT 教学工程

该工程让 STM32F103C8T6 实际执行裸机固件，经 UART 控制 ESP8266 AT 模型，后者经桌面宿主网络访问本机、局域网或允许的公网服务。它不运行 ESP8266 芯片内部固件，不模拟射频、信号强度、电流波动或模块烧毁。具体模型验收状态以该轮模块证据报告为准。

## 接线与固件

| 端子 / 器件 | 默认接线 | 说明 |
|---|---|---|
| ESP VCC / GND | 3V3 / GND | 真机需要匹配模块要求的稳定供电 |
| ESP RX / TX | PA2 / PA3 | USART2，115200 8N1；RX 接 MCU TX |
| ESP RST | PA4 | 固件 `RESET` 实际拉低后释放 |
| ESP EN / GPIO0 / GPIO2 | 3V3 | 本教学实例选择正常 AT 启动配置 |
| USB-TTL RX / TX / GND | PA9 / PA10 / GND | USART1 命令控制台，115200 8N1 |
| DHT11 DATA / VCC / GND | PB1 / 3V3 / GND | MQTT 温湿度上报；失败上报 null 与错误码 |
| LED 阳极 | PB13 → 330 Ω → A | LED K 接 GND；网络下行控制实际 GPIO |

这是独立工程，不直接占用原智慧农业工程的引脚。USART3 变体将 ESP 接 PA2/PA3 改为 PB10/PB11，其余相同。修改接线不会修改固件。

```sh
python3 firmware/esp8266/build.py
python3 firmware/esp8266/build.py --uart3
```

产物分别位于 `build/esp8266/uart2/` 与 `uart3/`，包含同次构建的 ELF/BIN/HEX、map、源代码、manifest、烧录包和独立 `project.json`。默认构建还同步 `templates/studio/esp8266/` 目录模板。

在独立桌面应用的“新建工程”中选择 **ESP8266 联网**，保存到新的空文件夹。模板包含可编辑的 `src/`、`include/`、锁定版本的 `drivers/`、实际接线和本机服务脚本。仓库的 `docs/examples/esp8266/project.json` 是辅助 JSON 示例；桌面完整验收应使用目录工程，不将浏览器打开 JSON 当作桌面验收。

## 选择本机或互联网网络范围

在桌面电路中选中 ESP8266，进入器件属性，将“网络范围”设为所需选项，再点击“应用属性”：

- **仅本机服务（可脱机）**，即默认的 `network_mode=local`：只允许电脑上的 loopback 地址和 `localhost`，可使用以下本机 TCP/MQTT 实验。局域网 IP 和公网域名会被拒绝。
- **本机、局域网与互联网**，即 `network_mode=internet`：通过电脑操作系统的 DNS、路由和真实 TCP 访问目标服务器。电脑需要能到达该服务器；本模型不自动继承浏览器代理，不支持 TLS/UDP。

网络范围是模块属性；控制台的 `SERVER 主机 端口` 只设置 MCU 要访问的服务器，不会修改网络范围。运行时切换范围会关闭当前 TCP 连接，Wi-Fi 教学入网状态仍保留；MCU 收到 `CLOSED` 后，控制台 `STATUS` 显示 `tcp=0`，此时重新 `TCP`，或重新执行 `MQTT`。若驱动已超时进入 `DESYNC`，先 `RESET`，再 `JOIN`/`TCP` 或 `MQTT`。属性区的“实时输入”仅用于切换“教学热点可用”，更改网络范围应使用“应用属性”。

SSID/密码定义虚拟教学热点，不控制电脑真实无线网卡；电脑可通过以太网或 Wi-Fi 联网。局域网或公网服务器还需符合本课程的 TCP/MQTT 协议范围；设置为互联网模式不代表任意服务器都能连接。

## 脱机 MQTT 实验

启动本机的简化 MQTT 3.1.1 教学服务，它通过真实 OS socket 通信，不读仿真模型，不向固件伪造响应。

```sh
python3 firmware/esp8266/network_fixture.py --mode mqtt --port 18883 --http-port 18884 --log /tmp/esp8266-mqtt.jsonl
```

以上命令从平台仓库根目录执行。已经通过桌面模板创建的工程也带有相同脚本，可以在新工程目录执行 `python3 tools/network_fixture.py --mode mqtt --port 18883 --http-port 18884`。本机服务需要独立运行，打开/烧录工程不会静默启动它。

烧录并运行工程，在接对线的虚拟 USB-TTL 控制台逐条发送，以换行结尾：

```text
SERVER 127.0.0.1 18883
MQTT
```

默认教学 SSID 是 `Studio-Lab`，密码 `studio123`；若模型参数已经改变，应先发送 `WIFI 新SSID|新密码`。SSID/密码来自运行时输入，不修改同一份 BIN。MCU 状态输出和模块诊断快照不回显密码；工程配置、串口输入记录及原始 UART 通信日志会保存教学凭据，十六进制记录也可还原原文。

依次观察 `mqtt_connack`、`mqtt_suback`、`sensor_publish`。每 2.5 秒 **MCU 仿真时间**，MCU 读取 PB1 上的 DHT11，编码 JSON，并作为 MQTT QoS0 消息发布到 `studio/telemetry`。改温湿度后，应检查服务器收到的新样本，不能只检查模型面板。

虚拟 CPU 和模拟电路步进不保证实时速度；包含 LED 电路求解时，2.5 秒 MCU 时间可能需要数十秒墙钟。真实 TCP 连接、网络超时和 broker keepalive 按墙钟运行，MCU 的 HAL 毫秒时钟按仿真时间运行，两者不能直接当作等速。本课程将 MQTT CONNECT keepalive 设为300秒，为慢速仿真留余量；本机教学服务接收空闲超时同为300秒。生产设备应根据实际网络调整 keepalive，不应据此宣称仿真时序与实物完全相同。

本机下发开灯命令：

```sh
curl -X POST http://127.0.0.1:18884/ -H 'Content-Type: application/json' -d '{"topic":"studio/control","payload":"ON"}'
```

将 `ON` 改为 `OFF` 关灯。HTTP 入口只是教师端发消息；消息仍须从 MQTT socket → ESP 模型 → 实际 UART → STM32 MQTT 解析器 → PB13 到达 LED。断开 ESP TX 后，MCU 不应收到控制命令。`GET http://127.0.0.1:18884/` 查看近100条服务记录。

本服务仅实现本课程所需的单主题精确订阅、QoS0、无认证 clean-session、PING，明确不是生产 MQTT broker。真实部署可选兼容 MQTT 3.1.1 的 broker，但本版 MCU 示例没有用户名/密码、TLS、QoS1/2 支持。`SEND OK` 只证明 AT 发送被接受；以服务器 `publish_received` 记录证明应用数据实际到达。

当前课程按单实例、独立本机服务设计：MCU 源码中的 MQTT client ID 固定为 `stm32-study`，主题固定为 `studio/telemetry` 和 `studio/control`。多名学生或多个实例连接同一标准 broker 时，重复 client ID 会使旧客户端断开，共用控制主题也会同时收到命令。共享 broker 前，学生应在源码中给每个实例设置唯一 client ID 和相互区分的发布/订阅主题，重新编译，并同步教师端主题；平台不会自动改写学生代码。

## TCP 二进制实验

使用不同空闲端口启动 echo 服务：

```sh
python3 firmware/esp8266/network_fixture.py --mode echo --port 18885 --log /tmp/esp8266-echo.jsonl
```

控制台依次发送：

```text
RESET
SERVER 127.0.0.1 18885
JOIN
TCP
SEND 00ff0d0a4f4b
SEND 4c45443d310a
```

第一条 SEND 验证 NUL、0xFF、CR/LF、`OK` 是数据，`esp_rx.hex` 应返回相同字节。第二条发送 `LED=1\n`，echo 经完整网络返回后开灯；`4c45443d300a` 对应关灯。

| 控制台命令 | 行为 |
|---|---|
| `AT` / `AT+GMR` 等 | 通过实际 UART 发送一条 AT 命令；打印本次状态 |
| `RESET` | 通过 PA4 复位模块，清空流解析状态；不自动重发请求 |
| `WIFI ssid\|password` | 只修改 MCU RAM 内的连接参数，`\|` 在这里表示分隔字符 `|` |
| `SERVER host port` | 修改 MCU RAM 内服务器地址，重启后恢复默认 |
| `JOIN` | AT 初始化并入网，不连接 TCP |
| `TCP` / `CLOSE` | 建立 / 关闭 TCP 单连接 |
| `TEXT 内容` | 将 UTF-8/ASCII 文本原样发送，不自动追加换行 |
| `SEND 十六进制` | 二进制发送；控制台一行最长511字节 |
| `MQTT` | 入网、TCP、MQTT CONNECT；收到成功 CONNACK 后订阅控制主题 |
| `PUB 内容` | 连接/订阅成功后发布到 `studio/telemetry` |
| `STATUS` | 当前协议状态、Wi-Fi/TCP、LED、UART 丢字节计数 |

超时或 UART 溢出后驱动进入失步状态，必须修复接线/服务器再 `RESET`，之后重新 `JOIN`/`TCP` 或 `MQTT`。不自动重试可能产生外部副作用的操作。正常断网仍要重新建立连接。控制台错误码：0 OK，1 BUSY，2 TIMEOUT，3 ERROR，4 ARGUMENT，5 IO，6 OVERFLOW，7 DESYNC。

## 驱动接口与资源边界

独立库 `DX_device_esp8266.h/.c` 通过 write/read/millis 回调访问真实 UART；支持非阻塞 command/poll，以及带毫秒超时的 exec/join/connect/send。应用不得在回调内重入事务。`millis` 必须在等待时正常前进，write 必须有界。

AT 解析行192字节、TCP接收环511个可用字节、单次发送上限2048字节、MQTT消息体上限512字节，均静态分配。应用每次只读64字节，持续处理；长时间阻塞或接收突发超限应报溢出，不应静默丢字节后继续解析成功。两个 USART 各有1024字节 IRQ 接收环；USB-TTL 的输出不代表 ESP 对端收到。

```sh
python3 libraries/nun-dx/tests/run_esp8266_tests.py
python3 libraries/nun-dx/tests/run_host_tests.py
python3 firmware/esp8266/test_network_fixture.py
```

以上是驱动与本机 socket 单元检查，不是双引擎或桌面端验收。真实 MCU 占用和 ELF/BIN/HEX 哈希以各构建 `manifest.json` 为准。

## 实物迁移

保留同一份 STM32 BIN，通过控制台配置真实 Wi-Fi 和服务器地址。实物访问电脑上的服务时，`127.0.0.1` 应改成电脑局域网 IP，教师服务也要显式绑定可访问的局域网地址。虚拟教学热点不会帮实体模块登录路由器。

当前未提供也未验证实体 ESP8266 的 AT 固件镜像；必须核对实际八针模块的 Flash 容量、UART0 GPIO1/3、115200 8N1、启动脚，以及其 AT 固件是否支持此命令子集。不能把 ESP32 镜像烧入 ESP8266。保持生成烧录包与实机验证两个状态分开。
