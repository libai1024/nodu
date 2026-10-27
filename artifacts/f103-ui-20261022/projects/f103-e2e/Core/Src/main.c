#include "main.h"

volatile uint32_t nodu_loop_count = 0;

int main(void)
{
    HAL_Init();
    SystemClock_Config();
    while (1) {
        nodu_loop_count++;
        HAL_Delay(100);
    }
}

void Error_Handler(void)
{
    __disable_irq();
    while (1) {}
}
