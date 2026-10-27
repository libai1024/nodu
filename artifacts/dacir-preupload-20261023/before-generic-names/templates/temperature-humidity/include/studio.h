/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef STUDIO_DEMO_H
#define STUDIO_DEMO_H
#include "stm32f1xx_hal.h"
#include "DX_driver_i2c.h"
#include "DX_device_0.9_i2c_oled.h"

typedef struct {
    int32_t temperature_tenths;  /* 235 = 23.5 degrees Celsius */
    uint16_t humidity_tenths;    /* 550 = 55.0 %RH */
} dht11_reading_t;

enum { DHT11_OK, DHT11_TIMEOUT, DHT11_CHECKSUM, DHT11_RANGE };

/* Real hardware setup: HSE 8 MHz -> PLL 72 MHz; USART1 PA9/PA10 115200 8N1. */
void studio_board_init(void);
/* 设置实际使用的 GPIO，须在 init 前调用；默认 PB1。改变接线不会修改该配置。 */
void dht11_config(GPIO_TypeDef *port, uint16_t pin);
void dht11_init(void); /* 模块需要 DATA 上拉至3.3V。 */
/* USART1发送字符串；read无收到数据返回-1，否则返回0..255。 */
void studio_uart_write(const char *text);
int studio_uart_read(void);
uint8_t dht11_read(dht11_reading_t *reading); /* Output unchanged on error. */
void studio_show_tenths(uint8_t x, uint8_t y, int32_t value, char unit);
void studio_log_sample(uint32_t sequence, const dht11_reading_t *reading,
                       uint8_t dht_status, uint8_t oled_status);
enum { SENSOR_OK, SENSOR_TIMEOUT, SENSOR_CHECKSUM, SENSOR_ARGUMENT };
/* 温度传感器：外部供电、单个DS18B20；读取约阻塞750ms。成功写入0.1°C单位，失败不修改输出。
 * 示例：int32_t t; uint8_t status=studio_ds18b20_read(GPIOB,GPIO_PIN_9,&t);
 */
uint8_t studio_ds18b20_read(GPIO_TypeDef *port, uint16_t pin, int32_t *temperature_tenths);
/* HC-SR04超声波测距：触发与回波引脚独立指定，成功输出毫米值，30ms无回波返回TIMEOUT。
 * 示例：uint32_t mm; studio_hcsr04_read(GPIOB,GPIO_PIN_0,GPIOB,GPIO_PIN_1,&mm);
 */
uint8_t studio_hcsr04_read(GPIO_TypeDef *trig_port, uint16_t trig_pin, GPIO_TypeDef *echo_port, uint16_t echo_pin, uint32_t *distance_mm);
#endif
