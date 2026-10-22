/* 板卡：{{BOARD_NAME}}。由 Nodu 板卡包 {{BOARD_ID}}@{{BOARD_VERSION}} 生成，可以修改。 */
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
