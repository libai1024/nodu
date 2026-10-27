#include <Arduino.h>
#include <ArduinoJson.h>
// 整份替换并保存 😀

void setup() {
  Serial.begin(115200);
  JsonDocument doc;
  doc["ready"] = true;
  Serial.println("ready");
}

void loop() {
  Serial.println("tick");
  delay(100);
}
