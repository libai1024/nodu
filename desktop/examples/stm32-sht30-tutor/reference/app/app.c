#include <stdio.h>
#include <stdlib.h>
#include "tutor_board.h"
#include "app.h"
#include "bsp_i2c.h"
#include "bsp_log.h"
#include "sht30.h"
#include "alarm.h"
#define SAMPLE_PERIOD_MS 1000u
#define READ_FAILS_BEFORE_RECOVER 3u
static uint32_t last_sample_ms;
static alarm_t over_temp = {30.0f, 28.0f, false};
static unsigned read_failures;
static void print_reading(sht30_reading_t r)
{
    char line[40];
    int t = (int)(r.celsius * 10.0f);  /* 以 0.1 °C 为单位 */
    int h = (int)(r.percent_rh * 10.0f);
    snprintf(line, sizeof line, "t=%s%d.%d C rh=%d.%d %%", t < 0 ? "-" : "", abs(t) / 10, abs(t) % 10, h / 10, h % 10);
    log_line(line);
}

static void sample_once(void)
{
    sht30_raw_t raw;
    if (sht30_read_raw(&raw) != SHT30_OK) {
        log_line("sht30: read failed");
        if (++read_failures >= READ_FAILS_BEFORE_RECOVER) {
            read_failures = 0;
            bsp_i2c_recover();
        }
        return;
    }
    read_failures = 0;
    sht30_reading_t r = sht30_convert(raw);
    print_reading(r);
    if (alarm_update(&over_temp, r.celsius)) {
        log_line(over_temp.active ? "alarm: on" : "alarm: off");
    }
}

void app_init(void)
{
    if (bsp_i2c_init() != HAL_OK) { (void)log_line("i2c: init failed"); }
    bsp_i2c_scan();
    last_sample_ms = HAL_GetTick();
}
void app_loop(void)
{
    uint32_t now = HAL_GetTick();
    if ((uint32_t)(now - last_sample_ms) >= SAMPLE_PERIOD_MS) {
        last_sample_ms = now;
        sample_once();
    }
}
