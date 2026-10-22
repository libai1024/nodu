#ifndef SHT30_H
#define SHT30_H
#include <stdint.h>

/* ADDR 引脚接 GND 时的 7 位地址；接 VDD 时为 0x45。 */
#define SHT30_ADDR_7BIT 0x44u

typedef enum {
    SHT30_OK = 0,
    SHT30_ERR_BUS,
    SHT30_ERR_CRC
} sht30_status_t;

/* 传感器返回的原始 16 位数值。 */
typedef struct {
    uint16_t temperature;
    uint16_t humidity;
} sht30_raw_t;

typedef struct {
    float celsius;
    float percent_rh;
} sht30_reading_t;

/* 纯函数（sht30_calc.c）：不依赖 HAL，可在电脑上测试。 */
uint8_t sht30_crc8(const uint8_t *data, uint8_t len);
sht30_reading_t sht30_convert(sht30_raw_t raw);

/* 总线访问（sht30.c）：单次测量并校验。 */
sht30_status_t sht30_read_raw(sht30_raw_t *out);

#endif
