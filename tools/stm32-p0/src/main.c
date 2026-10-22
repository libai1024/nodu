/* Nodu P0: ordinary HAL firmware, no board pin or external crystal assumptions. */
#if defined(STM32F103xB)
#include "stm32f1xx_hal.h"
#elif defined(STM32F407xx)
#include "stm32f4xx_hal.h"
#else
#error Unsupported P0 target
#endif

typedef struct {
    uint32_t magic;
    uint32_t target;
    uint32_t heartbeat;
    uint32_t hal_tick;
    uint32_t sysclk_hz;
    uint32_t error;
} NoduP0Status;

/* Read this symbol through SWD to prove the downloaded program is executing. */
volatile NoduP0Status nodu_p0_status = {0x4e445550, NODU_TARGET_NUMBER, 0, 0, 0, 0};

static void fail(uint32_t code)
{
    nodu_p0_status.error = code;
    for (;;) { /* Preserve the failure code for debugger inspection. */ }
}

static void SystemClock_Config(void)
{
    RCC_OscInitTypeDef oscillator = {0};
    RCC_ClkInitTypeDef clock = {0};
    oscillator.OscillatorType = RCC_OSCILLATORTYPE_HSI;
    oscillator.HSIState = RCC_HSI_ON;
    oscillator.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    oscillator.PLL.PLLState = RCC_PLL_NONE;
    if (HAL_RCC_OscConfig(&oscillator) != HAL_OK) { fail(2); }
    clock.ClockType = RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_HCLK |
                      RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    clock.SYSCLKSource = RCC_SYSCLKSOURCE_HSI;
    clock.AHBCLKDivider = RCC_SYSCLK_DIV1;
    clock.APB1CLKDivider = RCC_HCLK_DIV1;
    clock.APB2CLKDivider = RCC_HCLK_DIV1;
    if (HAL_RCC_ClockConfig(&clock, FLASH_LATENCY_0) != HAL_OK) { fail(3); }
}

int main(void)
{
    if (HAL_Init() != HAL_OK) { fail(1); }
    SystemClock_Config();
    nodu_p0_status.sysclk_hz = HAL_RCC_GetSysClockFreq();
    for (;;) {
        ++nodu_p0_status.heartbeat;
        nodu_p0_status.hal_tick = HAL_GetTick();
        HAL_Delay(250);
    }
}
