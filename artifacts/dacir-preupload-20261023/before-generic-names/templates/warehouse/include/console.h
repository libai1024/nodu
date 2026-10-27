/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef AGRI_CONSOLE_H
#define AGRI_CONSOLE_H
#include <stdint.h>
void console_init(void); /* USART1 PA9/PA10, after studio_board_init(). */
int console_read(void);  /* Nonblocking: -1 empty; 0..255 received byte. */
uint32_t console_errors(void); /* RX overflow or framing/noise/overrun events. */
uint32_t console_flush(void); /* Discard queued bytes atomically; return current error generation. */
void console_number(uint32_t value);
#endif
