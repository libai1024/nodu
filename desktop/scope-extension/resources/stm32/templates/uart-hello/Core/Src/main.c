/* {{NAME}}：每秒从调试串口打印一行。打开串口监视器（{{UART_BAUD}}）查看输出。 */
#include <stdio.h>
#include "main.h"

int main(void)
{
    HAL_Init();           /* 初始化 HAL 与 SysTick（1 ms） */
    SystemClock_Config(); /* 系统时钟，见 Board/board_clock.c */
    Board_DebugUartInit(BOARD_DEBUG_BAUD);

    printf("\r\n%s 已启动，系统时钟 %lu Hz\r\n", BOARD_NAME, (unsigned long)HAL_RCC_GetSysClockFreq());

    uint32_t count = 0;
    while (1)
    {
        printf("Hello from Nodu #%lu\r\n", (unsigned long)count);
        count++;
        HAL_Delay(1000);
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
