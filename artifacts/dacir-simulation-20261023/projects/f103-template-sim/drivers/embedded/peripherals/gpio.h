/* Modified 2026-10-23: generic file and API names; original license retained. */
/**
 * @file    gpio.h
 * @date    2026-08-01
 * @brief   GPIO 驱动头文件
 *          提供 STM32 GPIO 的初始化、读写、翻转等操作的统一接口
 */

#ifndef EMBEDDED_PERIPHERALS_GPIO_H
#define EMBEDDED_PERIPHERALS_GPIO_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "types.h"
#include "delay.h"

/* Exported types ------------------------------------------------------------*/

/**
 * @brief GPIO 工作模式枚举
 *        对 HAL 库 GPIO 模式进行封装,便于统一调用
 */
typedef enum
{
    GPIO_OUTPUT_PP,       /* 推挽输出           */
    GPIO_OUTPUT_OD,       /* 开漏输出           */
    GPIO_INPUT_FLOAT,     /* 浮空输入           */
    GPIO_INPUT_PULLUP,    /* 上拉输入           */
    GPIO_INPUT_PULLDOWN,  /* 下拉输入           */
    GPIO_ANALOG,          /* 模拟模式           */
    GPIO_AF_PP,           /* 复用推挽输出       */
    GPIO_AF_OD,           /* 复用开漏输出       */
    GPIO_IT_RISING,       /* 上升沿触发中断     */
    GPIO_IT_FALLING,      /* 下降沿触发中断     */
    GPIO_IT_BOTH,         /* 双边沿触发中断     */
} gpio_mode_enum;

/* Exported functions prototypes ---------------------------------------------*/

void    gpio_init    (GPIO_TypeDef *GPIOx, uint16_t GPIO_PIN, gpio_mode_enum mode);  /* GPIO 初始化         */
void    gpio_set_high (GPIO_TypeDef *GPIOx, uint16_t GPIO_PIN);                       /* 输出高电平          */
void    gpio_set_low  (GPIO_TypeDef *GPIOx, uint16_t GPIO_PIN);                       /* 输出低电平          */
void    gpio_toggle  (GPIO_TypeDef *GPIOx, uint16_t GPIO_PIN);                       /* 翻转输出电平        */
uint8   gpio_read    (GPIO_TypeDef *GPIOx, uint16_t GPIO_PIN);                       /* 读取输入电平        */

void    gpio_test    (void);                                                         /* GPIO 测试函数       */

#ifdef __cplusplus
}
#endif

#endif /* EMBEDDED_PERIPHERALS_GPIO_H */
