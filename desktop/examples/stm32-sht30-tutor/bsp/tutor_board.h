#ifndef TUTOR_BOARD_H
#define TUTOR_BOARD_H
#include "stm32f4xx_hal.h"
extern UART_HandleTypeDef board_log_uart;
extern I2C_HandleTypeDef board_sensor_i2c;
void board_init(void);
#endif
