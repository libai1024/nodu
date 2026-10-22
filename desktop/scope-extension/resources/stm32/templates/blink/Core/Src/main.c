/* {{NAME}}：LED0 每 500 ms 翻转一次，同时从调试串口打印次数。 */
#include <stdio.h>
#include "main.h"

/* LED0 的引脚在 Board/board.h 中定义。 */
static void Led_Init(void)
{
    GPIO_InitTypeDef pin = {0};
    LED0_GPIO_CLK_ENABLE();
    HAL_GPIO_WritePin(LED0_GPIO_PORT, LED0_PIN, LED0_OFF_LEVEL);

    pin.Pin = LED0_PIN;
    pin.Mode = GPIO_MODE_OUTPUT_PP;
    pin.Pull = GPIO_NOPULL;
    pin.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(LED0_GPIO_PORT, &pin);
}

int main(void)
{
    HAL_Init();           /* 初始化 HAL 与 SysTick（1 ms） */
    SystemClock_Config(); /* 系统时钟，见 Board/board_clock.c */
    Board_DebugUartInit(BOARD_DEBUG_BAUD);
    Led_Init();

    uint32_t count = 0;
    while (1)
    {
        HAL_GPIO_TogglePin(LED0_GPIO_PORT, LED0_PIN);
        printf("LED0 翻转 #%lu\r\n", (unsigned long)count);
        count++;
        HAL_Delay(500);
    }
}

/* HAL 初始化失败时停在这里。调试时可以在这一行设置断点。 */
void Error_Handler(void)
{
    __disable_irq();
    while (1)
    {
    }
}
