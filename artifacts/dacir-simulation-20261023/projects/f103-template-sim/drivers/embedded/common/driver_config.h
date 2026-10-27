/* Modified 2026-10-23: generic file and API names; original license retained. */
/* DACIR template distribution, 2026-10-23: omit the unused Emm V5 driver. */
/**
 * @file    driver_config.h
 * @date    2026-08-24
 * @brief   工程配置开关头文件
 *          集中管理各设备模块的启用/禁用开关:
 *          置 0 的模块 .c 整体被 #if 剔除,不编译、不占 Flash,
 *          统一头文件也不再包含其 API,避免误用
 */



#ifndef EMBEDDED_COMMON_DRIVER_CONFIG_H
#define EMBEDDED_COMMON_DRIVER_CONFIG_H

/* 设备层开关:1=启用,0=禁用 ------------------------------------------------ */
#define DEVICE_ENABLE_OLED        0   /* 0.9 寸 OLED 屏(I2C)          */
#define DEVICE_ENABLE_AHT10        0   /* AHT10 温湿度传感器(I2C)      */
#define DEVICE_ENABLE_AT24C64        0   /* AT24C64 EEPROM(I2C)          */
#define DEVICE_ENABLE_AS5600        0   /* AS5600 磁编码器(I2C)         */
#define DEVICE_ENABLE_BH1750        0   /* BH1750 光照强度传感器(I2C)   */
#define DEVICE_ENABLE_MPU6050        0   /* MPU6050 六轴姿态传感器(I2C)  */
#define DEVICE_ENABLE_KEY        1   /* 按键(GPIO,软件消抖)          */
#define DEVICE_ENABLE_SERVO        0   /* 舵机(PWM)                   */
#define DEVICE_ENABLE_ST7789        0   /* ST7789 彩屏(SPI)             */
#define DEVICE_ENABLE_TB6612        0   /* TB6612 双 H 桥电机驱动       */




/* 说明:底层外设驱动层保持无条件编译,其占用的 Flash 仅在对应
   设备启用时通过函数引用被链接,不用的外设驱动不会增加最终镜像 */

#endif /* EMBEDDED_COMMON_DRIVER_CONFIG_H */
