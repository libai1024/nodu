#if defined(STM32F103xB)
#include "stm32f1xx_hal.h"
#else
#include "stm32f4xx_hal.h"
#endif

void SysTick_Handler(void)
{
    HAL_IncTick();
    HAL_SYSTICK_IRQHandler();
}
