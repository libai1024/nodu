/* Modified 2026-10-23: generic file and API names; original license retained. */
/* SPDX-License-Identifier: AGPL-3.0-only
 * ESP8266 UART AT driver and bounded MQTT 3.1.1 teaching codec.
 * Copyright (C) 2026 STM32 Study Studio contributors.
 * No MCU/engine dependencies, dynamic allocation or implicit success values.
 */
#ifndef EMBEDDED_DEVICES_ESP8266_H
#define EMBEDDED_DEVICES_ESP8266_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define ESP8266_LINE_SIZE 192u
#define ESP8266_RX_SIZE 512u
#define ESP8266_SEND_MAX 2048u
#define ESP8266_MQTT_SIZE 512u

typedef enum {
    ESP8266_OK = 0, ESP8266_BUSY, ESP8266_TIMEOUT, ESP8266_ERROR,
    ESP8266_ARGUMENT, ESP8266_IO, ESP8266_OVERFLOW, ESP8266_DESYNC
} esp8266_status_t;

typedef struct {
    void *user;
    /* write: all bytes accepted => 1, failure => 0; must have a bounded wait. */
    int (*write)(void *user, const uint8_t *data, size_t length);
    /* read: one byte 0..255, -1 no data, -2 transport overflow/error. Nonblocking. */
    int (*read)(void *user);
    uint32_t (*millis)(void *user); /* monotonic modulo 2^32 */
    void (*idle)(void *user);       /* optional wait hook, IRQs must remain enabled */
} esp8266_io_t;

typedef struct {
    esp8266_io_t io;
    char line[ESP8266_LINE_SIZE];
    uint8_t rx[ESP8266_RX_SIZE];
    uint16_t line_used, rx_head, rx_tail;
    uint32_t payload_left, started_ms, timeout_ms, overflow_count;
    uint8_t line_drop, expect, desynchronized, wifi_connected, tcp_connected;
    esp8266_status_t status;
} esp8266_t;

/* 初始化解析器不发送命令、不复位模块。io 须指向真实 UART 与毫秒时钟。 */
esp8266_status_t esp8266_init(esp8266_t *device, const esp8266_io_t *io);
/* 非阻塞接收与超时推进；每次最多读64字节，主循环应频繁调用。 */
esp8266_status_t esp8266_poll(esp8266_t *device);
/* 单连接、主动接收模式的 TCP 字节流；返回字节数，包含0x00而非C字符串。 */
size_t esp8266_receive(esp8266_t *device, uint8_t *data, size_t capacity);
/* command 不包含CR/LF；异步启动，完成由poll/status确认，不在ISR里调用。 */
esp8266_status_t esp8266_command(esp8266_t *device, const char *command, uint32_t timeout_ms);
/* 有界等待命令完成；超时/串口丢字节使解析器DESYNC，须硬件复位后重新init。
 * 禁止自动重发可能产生副作用的命令。millis需持续前进。 */
esp8266_status_t esp8266_wait(esp8266_t *device);
esp8266_status_t esp8266_exec(esp8266_t *device, const char *command, uint32_t timeout_ms);
/* 配置 ATE0 / CWMODE=1 / CIPMUX=0。SSID和密码只从参数取得。 */
esp8266_status_t esp8266_configure(esp8266_t *device, uint32_t timeout_ms);
esp8266_status_t esp8266_join(esp8266_t *device, const char *ssid, const char *password, uint32_t timeout_ms);
esp8266_status_t esp8266_tcp_connect(esp8266_t *device, const char *host, uint16_t port, uint32_t timeout_ms);
/* 等待'>'后按原始长度发字节，随后等SEND OK；它不表示远端应用已确认收到。 */
esp8266_status_t esp8266_tcp_send(esp8266_t *device, const uint8_t *data, size_t length, uint32_t timeout_ms);
esp8266_status_t esp8266_tcp_close(esp8266_t *device, uint32_t timeout_ms);

/* MQTT 3.1.1：无认证、clean session、QoS0发布/订阅、keepalive、最大512字节。
 * 编码失败返回0；协议层完全运行于MCU，无ESP专用MQTT命令。 */
size_t esp8266_mqtt_connect(uint8_t *out, size_t capacity, const char *client_id, uint16_t keepalive_s);
size_t esp8266_mqtt_subscribe(uint8_t *out, size_t capacity, const char *topic, uint16_t packet_id);
size_t esp8266_mqtt_publish(uint8_t *out, size_t capacity, const char *topic, const uint8_t *payload, size_t length);
typedef enum { ESP_MQTT_NONE, ESP_MQTT_CONNACK, ESP_MQTT_SUBACK, ESP_MQTT_PUBLISH,
               ESP_MQTT_PINGRESP, ESP_MQTT_INVALID } esp8266_mqtt_event_t;
typedef struct {
    uint8_t packet[ESP8266_MQTT_SIZE];
    uint16_t used, topic_offset, topic_length, payload_offset, payload_length, packet_id;
    uint32_t remaining, multiplier, discard_left;
    uint8_t header, length_bytes, state, return_code;
} esp8266_mqtt_t;
void esp8266_mqtt_init(esp8266_mqtt_t *mqtt);
/* 对连续 TCP 字节逐个调用，处理分片/粘包。事件数据有效到下一次feed。 */
esp8266_mqtt_event_t esp8266_mqtt_feed(esp8266_mqtt_t *mqtt, uint8_t byte);

#ifdef __cplusplus
}
#endif
#endif
