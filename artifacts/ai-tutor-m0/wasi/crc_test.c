#include <stdint.h>
#include <stddef.h>
#include "unity.h"

#ifndef CRC_POLY
#define CRC_POLY 0x31
#endif

static uint8_t crc8(const uint8_t *data, size_t size) {
    uint8_t crc = 0xff;
    for (size_t i = 0; i < size; i++) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; bit++) {
            crc = (uint8_t)((crc & 0x80) ? (crc << 1) ^ CRC_POLY : crc << 1);
        }
    }
    return crc;
}
void setUp(void) {}
void tearDown(void) {}
static void datasheet_vector(void) {
    const uint8_t data[] = {0xbe, 0xef};
    TEST_ASSERT_EQUAL_HEX8(0x92, crc8(data, sizeof data));
}
static void damaged_data_rejected(void) {
    const uint8_t data[] = {0xbe, 0xee};
    TEST_ASSERT_NOT_EQUAL(0x92, crc8(data, sizeof data));
}
int main(void) {
    UNITY_BEGIN();
    RUN_TEST(datasheet_vector);
    RUN_TEST(damaged_data_rejected);
    return UNITY_END();
}
