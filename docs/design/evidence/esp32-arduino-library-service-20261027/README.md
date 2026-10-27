# Arduino 库服务真实闭环证据

2026-10-27，使用实际 `NoduArduinoServer` 和 Arduino CLI 1.5.1，在独立 ESP32-C3 / Core 3.3.12 临时工程中完成以下操作，最终全部通过。没有连接真实硬件。

1. `changeLibrary(remove ArduinoJson)` 返回 `ok=true, changed=true`；已引用列表不再包含 ArduinoJson，全部列表仍显示其内置状态但没有 `installedVersion`。
2. `changeLibrary(add ArduinoJson 7.4.3)` 返回 `ok=true, changed=true`；列表和标准 `sketch.yaml` 均恢复 7.4.3，原有 11 项依赖版本与 direct/dependency 属性恢复。
3. 实际编译包含 `JsonDocument`、`serializeJson(doc, Serial)` 的串口例子成功，诊断为空，未修改源代码。
4. 顶层注释、FQBN 行尾注释、另一个 profile 的注释和未修改 MQTT 库项的行尾注释均保留；其他 profile、Core、FQBN 等标准配置语义不变。

[最终结果](result.json)记录调用结果、列表变化、注释检查、应用固件摘要和真实 CLI 参数；[实际命令输出](fixed/commands.log)及 `fixed/` 中三个 YAML 快照可直接对照。21 次 `lib download` 均为已有版本，21 次均输出 `already downloaded`；没有请求额外库版本。缓存从已有隔离测试环境通过 APFS 克隆，没有改写原缓存或用户工程。

初轮曾发现真实缺陷：修改 ArduinoJson 会删除未改 MQTT 条目的行尾注释。该轮库 API、版本恢复和编译均成功，但整体记录为失败；[原始失败结果](initial-before-fix/result.json)、前后 YAML 与日志完整保留。主任务修复 YAML 节点复用并编译后，本次使用新工程重新执行全部闭环，得到根目录的成功结果。

- 初轮原始材料：`/private/tmp/nodu-arduino-library-service-20261027-m6aawiga/run`。
- 修复后原始材料：`/private/tmp/nodu-arduino-library-service-20261027-m6aawiga/run-fixed`。
- 验证脚本：[validate.cjs](validate.cjs)，为实际执行脚本的持久化副本。
- 归档 JSON 是原始结果的精简投影；YAML、示例与命令输出逐字节复制，原始 result 摘要在相应 `source-provenance.json`。

`SHA256SUMS` 覆盖除自身外的全部归档文件。在此目录执行 `shasum -a 256 -c SHA256SUMS` 可核对完整性。

需要复验时，从仓库根目录执行以下命令。第一个参数是已准备 `home/data`、`home/downloads`、`home/user` 的隔离测试根目录；第二个参数使用新的简短标签，脚本会创建新工程，已有同名工程会被拒绝。

```sh
node docs/design/evidence/esp32-arduino-library-service-20261027/validate.cjs \
  /private/tmp/nodu-arduino-library-service-20261027-m6aawiga recheck
```

脚本使用实际服务与本机 `/opt/homebrew/bin/arduino-cli`，不会连接串口。原测试使用 APFS 克隆缓存；其他主机需先准备同版本缓存并调整 CLI 路径。
