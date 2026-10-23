/* Link-only course defaults. Student definitions replace these weak functions.
 * Missing driver work reports errors; it never invents sensor readings. */
#include "tutor_board.h"
#include "app.h"
#include "bsp_i2c.h"
#include "bsp_log.h"
#include "sht30.h"
#include "alarm.h"
#define WEAK __attribute__((weak))
WEAK void app_init(void) {}
WEAK void app_loop(void) {}
WEAK int log_line(const char *text) { (void)text; return -1; }
WEAK HAL_StatusTypeDef bsp_i2c_init(void) { return HAL_ERROR; }
WEAK void bsp_i2c_scan(void) {}
WEAK HAL_StatusTypeDef bsp_i2c_recover(void) { return HAL_ERROR; }
WEAK sht30_status_t sht30_read_raw(sht30_raw_t *out) { (void)out; return SHT30_ERR_BUS; }
WEAK uint8_t sht30_crc8(const uint8_t *data, uint8_t len) { (void)data; (void)len; return 0; }
WEAK sht30_reading_t sht30_convert(sht30_raw_t raw) { (void)raw; return (sht30_reading_t){0}; }
WEAK bool alarm_update(alarm_t *alarm, float celsius) { (void)alarm; (void)celsius; return false; }
