/* 中断服务函数。新增外设中断时，在这里写 xxx_IRQHandler，并调用对应的 HAL 处理函数。 */
#include "main.h"
#include "{{SERIES_LOWER}}_it.h"

void NMI_Handler(void)
{
    while (1)
    {
    }
}

/* 访问了非法地址、栈溢出或调用了空函数指针时进入这里。 */
void HardFault_Handler(void)
{
    while (1)
    {
    }
}

void MemManage_Handler(void)
{
    while (1)
    {
    }
}

void BusFault_Handler(void)
{
    while (1)
    {
    }
}

void UsageFault_Handler(void)
{
    while (1)
    {
    }
}

void SVC_Handler(void)
{
}

void DebugMon_Handler(void)
{
}

void PendSV_Handler(void)
{
}

/* 每 1 ms 一次，为 HAL_Delay 和 HAL_GetTick 计时。 */
void SysTick_Handler(void)
{
    HAL_IncTick();
}
