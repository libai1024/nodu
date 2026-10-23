#include <string.h>
#include "tutor_board.h"
#include "bsp_log.h"
#define LOG_TIMEOUT_MS 100u  /* 115200 波特下 100 ms 约可发送 1 KB */

int log_line(const char *text)
{
    size_t len = strlen(text);
    if (len > UINT16_MAX) {
        return -1;
    }
    if (HAL_UART_Transmit(&board_log_uart, (const uint8_t *)text, (uint16_t)len, LOG_TIMEOUT_MS) != HAL_OK) {
        return -1;
    }
    if (HAL_UART_Transmit(&board_log_uart, (const uint8_t *)"\r\n", 2, LOG_TIMEOUT_MS) != HAL_OK) {
        return -1;
    }
    return 0;
}
