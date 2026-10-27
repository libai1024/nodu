/* 芯片：STM32F103C8T6。默认 USART1 引脚可按硬件连接修改。 */
#ifndef BOARD_H
#define BOARD_H

#include <stdint.h>

#define BOARD_NAME "STM32F103C8T6"

/* 调试串口：USART1，TX = PA9，RX = PA10。printf 的输出从这里发出。 */
#define BOARD_DEBUG_BAUD 115200U

void SystemClock_Config(void);
void Board_DebugUartInit(uint32_t baud);
int Board_DebugWrite(const char *data, int len);

#endif /* BOARD_H */

int Board_DebugRead(uint8_t *byte);
