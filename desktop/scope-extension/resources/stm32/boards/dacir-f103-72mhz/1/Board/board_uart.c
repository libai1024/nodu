/* 调试串口：USART2，TX = PA2，RX = PA3。printf 经 syscalls.c 的 _write 调用 Board_DebugWrite。 */
#include "main.h"

static UART_HandleTypeDef debug_uart;

void Board_DebugUartInit(uint32_t baud)
{
    debug_uart.Instance = USART2;
    debug_uart.Init.BaudRate = baud;
    debug_uart.Init.WordLength = UART_WORDLENGTH_8B;
    debug_uart.Init.StopBits = UART_STOPBITS_1;
    debug_uart.Init.Parity = UART_PARITY_NONE;
    debug_uart.Init.Mode = UART_MODE_TX_RX;
    debug_uart.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    debug_uart.Init.OverSampling = UART_OVERSAMPLING_16;
    if (HAL_UART_Init(&debug_uart) != HAL_OK)
    {
        Error_Handler();
    }
}

/* HAL_UART_Init 调用这里打开时钟、配置引脚。F1 的 TX 用复用推挽输出，RX 用上拉输入。 */
void HAL_UART_MspInit(UART_HandleTypeDef *huart)
{
    if (huart->Instance == USART2)
    {
        GPIO_InitTypeDef pin = {0};
        __HAL_RCC_USART2_CLK_ENABLE();
        __HAL_RCC_GPIOA_CLK_ENABLE();

        pin.Pin = GPIO_PIN_2;
        pin.Mode = GPIO_MODE_AF_PP;
        pin.Speed = GPIO_SPEED_FREQ_HIGH;
        HAL_GPIO_Init(GPIOA, &pin);

        pin.Pin = GPIO_PIN_3;
        pin.Mode = GPIO_MODE_INPUT;
        pin.Pull = GPIO_PULLUP;
        HAL_GPIO_Init(GPIOA, &pin);
    }
}

int Board_DebugWrite(const char *data, int len)
{
    if (debug_uart.Instance == NULL)
    {
        return 0; /* 未初始化，未发送字节。 */
    }
    for (int sent = 0; sent < len;)
    {
        uint16_t chunk = (uint16_t)((len - sent) > 0xFFFF ? 0xFFFF : (len - sent));
        if (HAL_UART_Transmit(&debug_uart, (const uint8_t *)data + sent, chunk, 100) != HAL_OK) return sent;
        sent += chunk;
    }
    return len;
}
