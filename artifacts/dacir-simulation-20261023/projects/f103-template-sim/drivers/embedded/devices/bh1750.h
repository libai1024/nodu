/* Modified 2026-10-23: generic file and API names; original license retained. */
/**
 * @file    bh1750.h
 * @date    2026-08-02
 * @brief   BH1750 光照强度传感器设备头文件
 *          提供基于 I2C 的光照强度读取接口
 */

#ifndef EMBEDDED_DEVICES_BH1750_H
#define EMBEDDED_DEVICES_BH1750_H
#include "types.h"      /* 先引入配置开关(driver_config.h),保证下方 #if 可见 */
#if DEVICE_ENABLE_BH1750

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "embedded.h"
#include "i2c.h"

/* Exported defines ----------------------------------------------------------*/

#define BH1750_ADDR     0x23    /* BH1750 I2C 7 位设备地址(ADDR 引脚接地,接高为 0x5C) */

/* Exported functions prototypes ---------------------------------------------*/

float   bh1750_read_lux    (void);     /* 读取光照强度(lx) */
void    bh1750_test        (void);     /* BH1750 测试函数  */

#ifdef __cplusplus
}
#endif

#endif /* DEVICE_ENABLE_BH1750 */
#endif /* EMBEDDED_DEVICES_BH1750_H */
