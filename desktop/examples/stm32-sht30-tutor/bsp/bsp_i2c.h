#ifndef BSP_I2C_H
#define BSP_I2C_H
#include "tutor_board.h"

/* 配置并初始化传感器 I2C。 */
HAL_StatusTypeDef bsp_i2c_init(void);
/* 扫描总线，把应答的 7 位地址打印到日志。 */
void bsp_i2c_scan(void);
/* 总线异常后重新初始化 I2C。 */
HAL_StatusTypeDef bsp_i2c_recover(void);

#endif
