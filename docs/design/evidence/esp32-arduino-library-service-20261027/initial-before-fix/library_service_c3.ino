#include <Arduino.h>
#include <ArduinoJson.h>

void setup() {
  Serial.begin(115200);
  JsonDocument doc;
  doc["answer"] = 42;
  serializeJson(doc, Serial);
  Serial.println();
}

void loop() { delay(1000); }
