#include "main.h"
#include "tutor_board.h"
UART_HandleTypeDef board_log_uart;
I2C_HandleTypeDef board_sensor_i2c;
void board_init(void)
{
    HAL_Init();
    SystemClock_Config();
    board_log_uart.Instance = USART1;
    board_log_uart.Init.BaudRate = 115200;
    board_log_uart.Init.WordLength = UART_WORDLENGTH_8B;
    board_log_uart.Init.StopBits = UART_STOPBITS_1;
    board_log_uart.Init.Parity = UART_PARITY_NONE;
    board_log_uart.Init.Mode = UART_MODE_TX_RX;
    board_log_uart.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    board_log_uart.Init.OverSampling = UART_OVERSAMPLING_16;
    if (HAL_UART_Init(&board_log_uart) != HAL_OK) { Error_Handler(); }
    board_sensor_i2c.Instance = I2C1;
}
void HAL_I2C_MspInit(I2C_HandleTypeDef *i2c)
{
    if (i2c->Instance != I2C1) { return; }
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_I2C1_CLK_ENABLE();
    GPIO_InitTypeDef pin = {0};
    pin.Pin = GPIO_PIN_6 | GPIO_PIN_7;
    pin.Mode = GPIO_MODE_AF_OD;
    pin.Pull = GPIO_NOPULL;
    pin.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    pin.Alternate = GPIO_AF4_I2C1;
    HAL_GPIO_Init(GPIOB, &pin);
}
void Error_Handler(void) { __disable_irq(); for (;;) {} }
