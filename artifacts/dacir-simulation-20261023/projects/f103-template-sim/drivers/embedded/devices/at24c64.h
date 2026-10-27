/* Modified 2026-10-23: generic file and API names; original license retained. */
/**
 * @file    at24c64.h
 * @date    2026-08-23
 * @brief   AT24C64 EEPROM 设备驱动头文件
 *          基于 I2C 驱动封装 64Kbit(8KB)EEPROM 的读写接口,
 *          支持单字节读写与多字节读写(自动按页边界拆分写入)
 */

#ifndef EMBEDDED_DEVICES_AT24C64_H
#define EMBEDDED_DEVICES_AT24C64_H
#include "types.h"      /* 先引入配置开关(driver_config.h),保证下方 #if 可见 */
#if DEVICE_ENABLE_AT24C64

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "embedded.h"
#include "i2c.h"

/* Exported defines ----------------------------------------------------------*/

#define AT24C64_ADDR            0x50    /* AT24C64 I2C 7 位设备地址(A0/A1/A2 接地) */
#define AT24C64_SIZE            8192    /* 容量(字节):64Kbit = 8KB                 */
#define AT24C64_PAGE_SIZE       32      /* 页大小(字节):单次页写最大长度            */
#define AT24C64_WRITE_CYCLE_MS  5       /* 页写周期等待时间(ms),写入后内部等待       */

/* Exported functions prototypes ---------------------------------------------*/

uint8   at24c64_write_byte  (uint16 addr, uint8 data);                        /* 写单个字节                     */
int16   at24c64_read_byte   (uint16 addr);                                    /* 读单个字节,失败返回 -1         */
uint8   at24c64_write       (uint16 addr, const uint8 *buf, uint16 len);      /* 多字节写(自动跨页拆分)         */
uint8   at24c64_read        (uint16 addr, uint8 *buf, uint16 len);            /* 多字节读(顺序读可跨页)         */
void    at24c64_test        (void);                                           /* 测试函数                       */

#ifdef __cplusplus
}
#endif

#endif /* DEVICE_ENABLE_AT24C64 */
#endif /* EMBEDDED_DEVICES_AT24C64_H */
