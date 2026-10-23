#include <stdio.h>
#include "tutor_board.h"
#include "bsp_i2c.h"
#include "bsp_log.h"
#define SENSOR_I2C_SPEED_HZ 100000u  /* 标准模式 */

HAL_StatusTypeDef bsp_i2c_init(void)
{
    board_sensor_i2c.Init.ClockSpeed = SENSOR_I2C_SPEED_HZ;
    board_sensor_i2c.Init.DutyCycle = I2C_DUTYCYCLE_2;
    board_sensor_i2c.Init.OwnAddress1 = 0;
    board_sensor_i2c.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
    board_sensor_i2c.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
    board_sensor_i2c.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
    board_sensor_i2c.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
    HAL_StatusTypeDef status = HAL_I2C_Init(&board_sensor_i2c);
    if (status != HAL_OK) {
        log_line("i2c: init failed");
    }
    return status;
}
#define I2C_SCAN_TIMEOUT_MS 2u

void bsp_i2c_scan(void)
{
    char line[24];
    int found = 0;
    for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
        if (HAL_I2C_IsDeviceReady(&board_sensor_i2c, (uint16_t)(addr << 1), 1, I2C_SCAN_TIMEOUT_MS) == HAL_OK) {
            snprintf(line, sizeof line, "i2c: 0x%02X", addr);
            log_line(line);
            found++;
        }
    }
    if (!found) {
        log_line("i2c: no device");
    }
}
HAL_StatusTypeDef bsp_i2c_recover(void)
{
    log_line("i2c: recover");
    (void)HAL_I2C_DeInit(&board_sensor_i2c);  /* 外设已出错时也继续重新初始化 */
    return bsp_i2c_init();
}
