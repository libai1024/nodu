/* SPDX-License-Identifier: AGPL-3.0-only */
#define __DX_CONFIG_H
#define DX_USE_OLED 1
/* This application owns IRQ-driven receive buffers. Unused library handlers
 * retain their definitions under separate names and are removed by the linker. */
#define USART1_IRQHandler esp_unused_library_USART1_IRQHandler
#define USART2_IRQHandler esp_unused_library_USART2_IRQHandler
#define USART3_IRQHandler esp_unused_library_USART3_IRQHandler
#define ESP_UART3 0
#define ESP_BAUD 115200u
