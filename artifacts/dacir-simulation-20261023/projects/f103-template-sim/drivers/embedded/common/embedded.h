/* Modified 2026-10-23: generic file and API names; original license retained. */
/* DACIR template distribution, 2026-10-23: omit the unused Emm V5 driver. */
#ifndef EMBEDDED_COMMON_EMBEDDED_H
#define EMBEDDED_COMMON_EMBEDDED_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "stm32f1xx_hal.h"

#include "types.h"

#include "gpio.h"
#include "delay.h"
#include "uart.h"
#include "adc.h"
#include "i2c.h"
#include "spi.h"
#include "timer.h"
#include "timer_trigger.h"
#include "timer_encoder.h"
#include "pwm.h"
#include "exti.h"
#include "dma.h"
#if DEVICE_ENABLE_MPU6050
#include "mpu6050.h"
#endif /* DEVICE_ENABLE_MPU6050 */
#if DEVICE_ENABLE_OLED
#include "ssd1306.h"
#endif /* DEVICE_ENABLE_OLED */
#if DEVICE_ENABLE_TB6612
#include "tb6612.h"
#endif /* DEVICE_ENABLE_TB6612 */
#if DEVICE_ENABLE_SERVO
#include "servo.h"
#endif /* DEVICE_ENABLE_SERVO */
#if DEVICE_ENABLE_KEY
#include "key.h"
#endif /* DEVICE_ENABLE_KEY */
#if DEVICE_ENABLE_AS5600
#include "as5600.h"
#endif /* DEVICE_ENABLE_AS5600 */
#if DEVICE_ENABLE_AHT10
#include "aht10.h"
#endif /* DEVICE_ENABLE_AHT10 */
#if DEVICE_ENABLE_AT24C64
#include "at24c64.h"
#endif /* DEVICE_ENABLE_AT24C64 */
#if DEVICE_ENABLE_BH1750
#include "bh1750.h"
#endif /* DEVICE_ENABLE_BH1750 */
#if DEVICE_ENABLE_ST7789
#include "st7789.h"
#endif /* DEVICE_ENABLE_ST7789 */

#include "pid.h"

#include "interrupts.h"
#include "debug.h"
#include "fifo.h"

#ifdef __cplusplus
}
#endif

#endif /* EMBEDDED_COMMON_EMBEDDED_H */
