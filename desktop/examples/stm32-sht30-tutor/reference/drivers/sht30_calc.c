#include "sht30.h"
#define SHT30_CRC_POLY 0x31u  /* x^8 + x^5 + x^4 + 1，数据手册 Checksum Calculation */
#define SHT30_CRC_INIT 0xFFu

uint8_t sht30_crc8(const uint8_t *data, uint8_t len)
{
    uint8_t crc = SHT30_CRC_INIT;
    for (uint8_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80u) ? (uint8_t)((crc << 1) ^ SHT30_CRC_POLY) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}
#define SHT30_RAW_FULL_SCALE 65535.0f  /* 2^16 - 1 */

sht30_reading_t sht30_convert(sht30_raw_t raw)
{
    sht30_reading_t r;
    r.celsius = -45.0f + 175.0f * (float)raw.temperature / SHT30_RAW_FULL_SCALE;
    r.percent_rh = 100.0f * (float)raw.humidity / SHT30_RAW_FULL_SCALE;
    return r;
}
