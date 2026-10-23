/* SPDX-License-Identifier: AGPL-3.0-only
 * 仓库温湿度监测，STM32F103C8T6 / HSE 8MHz -> 72MHz。
 * 接线独立于本文件：DHT11 PB1；OLED PB6/PB7；USART1 PA9/PA10。
 * PB0 按键接地翻页，PB15 经 330Ω 和 LED 到地作为异常/超限指示。
 * 环境值来自真实驱动读取；失败时报告 null，不沿用上次有效数值。
 */
#include "studio.h"
#include "console.h"

#define WAREHOUSE_DHT_PIN GPIO_PIN_1
#define WAREHOUSE_TEMP_OFFSET_TENTHS 0
#define SAMPLE_INTERVAL_MS 1200U

static dht11_reading_t reading;
static uint8_t dht_status = DHT11_TIMEOUT, oled_status = OLED_ERR_I2C;
static uint32_t sequence, page, button_count, command_count;
static uint32_t temperature_limit = 30, humidity_limit = 75;
static uint8_t alarm;

static void text(const char *value) { studio_uart_write(value); }
static void number(uint32_t value) { console_number(value); }
static int equal(const char *left, const char *right)
{
    while (*left && *left == *right) { ++left; ++right; }
    return *left == *right;
}

static void output_state(void)
{
    alarm = dht_status != DHT11_OK || reading.temperature_tenths >= (int32_t)(temperature_limit * 10U)
        || reading.humidity_tenths >= humidity_limit * 10U;
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_15, alarm ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void display(void)
{
    if (oled_status != OLED_OK) oled_status = oled_init_checked();
    if (oled_status != OLED_OK) return;
    oled_clear();
    if (page == 0) {
        oled_show_utf8(0, 0, "温湿度测量");
        if (dht_status == DHT11_OK) {
            oled_show_utf8(0, 16, "温度:");
            studio_show_tenths(40, 16, reading.temperature_tenths, 'C');
            oled_show_utf8(0, 32, "湿度:");
            studio_show_tenths(40, 32, reading.humidity_tenths, '%');
            oled_show_string(0, 48, alarm ? "ALARM" : "NORMAL", OLED_FONT_8X16);
        } else {
            oled_show_utf8(0, 16, "传感器异常");
            oled_show_string(0, 40, "CHECK DATA", OLED_FONT_8X16);
        }
    } else {
        oled_show_string(0, 0, "WAREHOUSE LIMIT", OLED_FONT_8X16);
        oled_show_string(0, 16, "TEMP:", OLED_FONT_8X16);
        studio_show_tenths(48, 16, (int32_t)temperature_limit * 10, 'C');
        oled_show_string(0, 32, "HUM:", OLED_FONT_8X16);
        studio_show_tenths(48, 32, (int32_t)humidity_limit * 10, '%');
        oled_show_string(0, 48, "PB0: NEXT PAGE", OLED_FONT_8X16);
    }
    oled_status = oled_refresh_checked();
}

static void report(void)
{
    text("{\"case\":\"warehouse\",\"sequence\":"); number(sequence);
    text(",\"tick_ms\":"); number(HAL_GetTick());
    text(",\"temperature_tenths\":");
    if (dht_status == DHT11_OK) number((uint32_t)reading.temperature_tenths); else text("null");
    text(",\"humidity_tenths\":");
    if (dht_status == DHT11_OK) number(reading.humidity_tenths); else text("null");
    text(",\"dht_status\":"); number(dht_status);
    text(",\"oled_status\":"); number(oled_status);
    text(",\"alarm\":"); number(alarm);
    text(",\"page\":"); number(page);
    text(",\"button_count\":"); number(button_count);
    text(",\"temperature_limit\":"); number(temperature_limit);
    text(",\"command_count\":"); number(command_count);
    text(",\"rx_errors\":"); number(console_errors());
    text("}\r\n");
}

static void poll_console(void)
{
    static char line[48];
    static unsigned length;
    static uint8_t overflow;
    int ch;
    while ((ch = console_read()) >= 0) {
        if (ch == '\r') continue;
        if (ch != '\n') {
            if (length + 1 < sizeof(line) && !overflow) line[length++] = (char)ch;
            else overflow = 1;
            continue;
        }
        if (!length && !overflow) continue;
        line[length] = 0;
        uint8_t accepted = !overflow;
        if (accepted && equal(line, "page")) page ^= 1;
        else if (accepted && equal(line, "threshold 30")) temperature_limit = 30;
        else if (accepted && equal(line, "threshold 35")) temperature_limit = 35;
        else if (!(accepted && equal(line, "status"))) accepted = 0;
        if (accepted) { ++command_count; output_state(); display(); }
        text("{\"case\":\"warehouse_command\",\"accepted\":"); number(accepted);
        text(",\"count\":"); number(command_count); text("}\r\n");
        if (accepted) report();
        length = 0; overflow = 0;
    }
}

int main(void)
{
    studio_board_init();
    console_init();
    dht11_config(GPIOB, WAREHOUSE_DHT_PIN);
    dht11_init();
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = GPIO_PIN_0; gpio.Mode = GPIO_MODE_INPUT; gpio.Pull = GPIO_PULLUP;
    HAL_GPIO_Init(GPIOB, &gpio);
    gpio.Pin = GPIO_PIN_15; gpio.Mode = GPIO_MODE_OUTPUT_PP; gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW; HAL_GPIO_Init(GPIOB, &gpio);
    output_state();
    i2c_init(I2C_1, 100000, I2C1_SCL_PB6_SDA_PB7);
    oled_status = oled_init_checked();
    uint32_t next_sample = HAL_GetTick() + 1100U, changed_at = HAL_GetTick();
    uint8_t raw = 0, stable = 0;
    for (;;) {
        uint32_t now = HAL_GetTick();
        uint8_t down = HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_0) == GPIO_PIN_RESET;
        if (down != raw) { raw = down; changed_at = now; }
        if (raw != stable && now - changed_at >= 25U) {
            stable = raw;
            if (stable) { page ^= 1; ++button_count; display(); report(); }
        }
        poll_console();
        if ((int32_t)(now - next_sample) >= 0) {
            dht_status = dht11_read(&reading);
            if (dht_status == DHT11_OK) reading.temperature_tenths += WAREHOUSE_TEMP_OFFSET_TENTHS;
            ++sequence; output_state(); display(); report();
            next_sample = HAL_GetTick() + SAMPLE_INTERVAL_MS;
        }
        HAL_Delay(5);
    }
}
