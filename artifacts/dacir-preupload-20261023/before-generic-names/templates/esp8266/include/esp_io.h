/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef ESP_IO_H
#define ESP_IO_H
#include "DX_device_esp8266.h"
#ifndef ESP_UART3
#define ESP_UART3 0
#endif
#ifndef ESP_BAUD
#define ESP_BAUD 115200u
#endif
void esp_io_init(void);
void esp_io_reset_module(void); /* real PA4 output controls RST */
esp8266_io_t esp_io_callbacks(void);
int esp_console_read(void);
uint32_t esp_io_errors(void);
void esp_number(uint32_t value);
#endif
