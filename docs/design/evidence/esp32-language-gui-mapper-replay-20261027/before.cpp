#line 1 "/private/tmp/nodu-arduino-electron-20261027/projects/arduino_ui_c3/arduino_ui_c3.ino"
#include <Arduino.h>
#include <ArduinoJson.h>
#include "review-helper.h"

// 中文测试 🌟
// 整段替换后检查新行号 🚀

#line 8 "/private/tmp/nodu-arduino-electron-20261027/projects/arduino_ui_c3/arduino_ui_c3.ino"
void setup();
#line 21 "/private/tmp/nodu-arduino-electron-20261027/projects/arduino_ui_c3/arduino_ui_c3.ino"
void loop();
#line 8 "/private/tmp/nodu-arduino-electron-20261027/projects/arduino_ui_c3/arduino_ui_c3.ino"
void setup() {
  Serial.begin(115200);
  // 普通中文 🌟 增量验证 ✅
  // 第二次 🚀
  int localValue = 42;
  Serial.println(localValue);
  JsonDocument doc;
  doc["device"] = "ESP32-C3";
  Serial.println(reviewValue());
  serializeJson(doc, Serial);
  reviewValue();
}

void loop() {
  delay(1000);
}
