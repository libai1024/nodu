/* 芯片：{{BOARD_NAME}}。默认 USART1 引脚可按硬件连接修改。 */
#ifndef BOARD_H
#define BOARD_H

#include <stdint.h>

#define BOARD_NAME "{{BOARD_NAME}}"

/* 调试串口：{{UART_INSTANCE}}，TX = {{UART_TX}}，RX = {{UART_RX}}。printf 的输出从这里发出。 */
#define BOARD_DEBUG_BAUD {{UART_BAUD}}U

void SystemClock_Config(void);
void Board_DebugUartInit(uint32_t baud);
int Board_DebugWrite(const char *data, int len);
{{LED_BLOCK}}
#endif /* BOARD_H */
