/* SPDX-License-Identifier: AGPL-3.0-only
 * Directory projects using HAL need a running default millisecond timebase.
 * A project's strong SysTick_Handler replaces this weak implementation.
 */
#include "stm32f1xx_hal.h"

__attribute__((weak)) void SysTick_Handler(void)
{
    HAL_IncTick();
}
