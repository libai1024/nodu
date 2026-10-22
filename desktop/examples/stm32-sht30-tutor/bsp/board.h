#ifndef BOARD_H
#define BOARD_H
/* 由 Nodu 板卡包按所选开发板生成：时钟、引脚复用和外设实例都以板卡包为准。
 * T1 原型没有板卡包，本工程只用于练习书写，还不能构建和下载。 */
#include "stm32f4xx_hal.h"

/* board_init() 返回后已可使用的日志串口。 */
extern UART_HandleTypeDef board_log_uart;
/* Instance 与引脚已由板卡包设置；Init 参数在 S3 由你填写。 */
extern I2C_HandleTypeDef board_sensor_i2c;

/* HAL_Init、系统时钟、GPIO 复用与日志串口初始化。 */
void board_init(void);

#endif
