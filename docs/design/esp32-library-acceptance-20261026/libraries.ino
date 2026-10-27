#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <ArduinoMqttClient.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Adafruit_I2CDevice.h>
#include <Adafruit_NeoPixel.h>
#include <DHT.h>
#include <Adafruit_Sensor.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ESP32Servo.h>
WiFiClient transport;
MqttClient mqtt(transport);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_I2CDevice i2c(0x3c);
Adafruit_NeoPixel pixels(1, 4, NEO_GRB + NEO_KHZ800);
DHT dht(5, DHT22);
OneWire wire(6);
DallasTemperature temperatures(&wire);
Servo servo;
void setup() {
  Serial.begin(115200);
  JsonDocument json;
  deserializeJson(json, "{\"ok\":true}");
  serializeJson(json, Serial);
  mqtt.setId("nodu-library-compile-check");
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3c);
  oled.drawPixel(0, 0, SSD1306_WHITE);
  i2c.begin(); pixels.begin(); pixels.setPixelColor(0, 12, 0, 0); pixels.show();
  dht.begin(); Serial.println(dht.readTemperature());
  temperatures.begin(); temperatures.requestTemperatures();
  servo.attach(7); servo.write(90);
}
void loop() { delay(1000); }
