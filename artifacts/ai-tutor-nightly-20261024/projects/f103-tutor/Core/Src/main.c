/* f103-tutor：空工程。在 while (1) 中写你的程序。 */
#include "main.h"

int main(void)
{
    HAL_Init();           /* 初始化 HAL 与 SysTick（1 ms） */
    SystemClock_Config(); /* 系统时钟，见 Board/board_clock.c */
    Board_DebugUartInit(BOARD_DEBUG_BAUD); /* USART1 PA9/PA10，见 board.h */

    while (1)
    {
        const char msg[] = "NODU_TUTOR_F103_20261024\r\n";
        Board_DebugWrite(msg, sizeof(msg) - 1);
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
