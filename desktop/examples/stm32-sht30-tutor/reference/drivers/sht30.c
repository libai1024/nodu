#include "tutor_board.h"
#include "sht30.h"
#define SHT30_CMD_SINGLE_HIGH 0x2400u  /* 单次测量，高重复性，不使用时钟延展 */
#define SHT30_MEASURE_WAIT_MS 20u      /* 不短于最长测量时间，留出余量 */
#define SHT30_I2C_TIMEOUT_MS  10u
#define SHT30_I2C_ADDR        (SHT30_ADDR_7BIT << 1)  /* HAL 使用左移后的地址 */

sht30_status_t sht30_read_raw(sht30_raw_t *out)
{
    if (!out) { return SHT30_ERR_BUS; }
    uint8_t cmd[2] = { (uint8_t)(SHT30_CMD_SINGLE_HIGH >> 8), (uint8_t)(SHT30_CMD_SINGLE_HIGH & 0xFFu) };
    uint8_t rx[6];
    if (HAL_I2C_Master_Transmit(&board_sensor_i2c, SHT30_I2C_ADDR, cmd, sizeof cmd, SHT30_I2C_TIMEOUT_MS) != HAL_OK) {
        return SHT30_ERR_BUS;
    }
    HAL_Delay(SHT30_MEASURE_WAIT_MS);  /* 1 秒采样一次时，20 ms 的等待可以接受 */
    if (HAL_I2C_Master_Receive(&board_sensor_i2c, SHT30_I2C_ADDR, rx, sizeof rx, SHT30_I2C_TIMEOUT_MS) != HAL_OK) {
        return SHT30_ERR_BUS;
    }
    if (sht30_crc8(&rx[0], 2) != rx[2] || sht30_crc8(&rx[3], 2) != rx[5]) {
        return SHT30_ERR_CRC;
    }
    out->temperature = (uint16_t)((rx[0] << 8) | rx[1]);
    out->humidity = (uint16_t)((rx[3] << 8) | rx[4]);
    return SHT30_OK;
}
