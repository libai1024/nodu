/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef WAREHOUSE_CONFIG_H
#define WAREHOUSE_CONFIG_H
#define __DX_CONFIG_H
#define DX_USE_OLED 1
#define DX_USE_AS5600 0
#define DX_USE_KEY 1
/* Project-local interrupt receiver; keep the independent library untouched. */
#define USART1_IRQHandler warehouse_unused_library_USART1_IRQHandler
#endif
