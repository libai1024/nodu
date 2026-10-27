#include <Arduino.h>
#include <ArduinoJson.h>
#include "review-helper.h"

// 中文测试 🌟
// 整段替换后检查新行号 🚀

void setup() {
  Serial.begin(115200);
  JsonDocument doc;
  doc["device"] = "ESP32-C3";
  Serial.println(reviewValue());
  serializeJson(doc, Serial);
  nodu_unicode_missing();
}

void loop() {
  delay(1000);
}
