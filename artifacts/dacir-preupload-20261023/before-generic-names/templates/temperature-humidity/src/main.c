/* SPDX-License-Identifier: AGPL-3.0-only
 * 温湿度实验：DHT11 DATA -> PB1；OLED SCL -> PB6，SDA -> PB7。
 * 两个模块的 VCC 接 3.3 V，GND 共地。串口 PA9，115200 8N1。
 * 这份程序使用真实 GPIO / I2C，可下载 ELF、HEX、BIN 后烧入实体板。
 */
#include "studio.h"

#define SAMPLE_INTERVAL_MS 1000U       /* DHT11 两次采样至少相隔 1 秒 */
#define TEMPERATURE_OFFSET_TENTHS 0    /* 练习：改成 20，显示温度增加 2.0°C */

int main(void)
{
    studio_board_init();
    dht11_config(GPIOB, GPIO_PIN_1); /* 固件选择DATA引脚；接线由你独立完成 */
    dht11_init();
    i2c_init(I2C_1, 100000, I2C1_SCL_PB6_SDA_PB7);
    uint8_t oled_status = oled_init_checked();
    uint32_t sample = 0;
    dht11_reading_t reading = {0};

    HAL_Delay(1000); /* 给真实 DHT11 留出上电稳定时间 */
    while (1)
    {
        uint8_t dht_status = dht11_read(&reading);
        if (dht_status == DHT11_OK)
            reading.temperature_tenths += TEMPERATURE_OFFSET_TENTHS;

        /* OLED 断线时返回错误，下次采样自动重新初始化。 */
        if (oled_status != OLED_OK)
            oled_status = oled_init_checked();
        if (oled_status == OLED_OK)
        {
            oled_clear();
            oled_show_utf8(0, 0, "温湿度测量");
            if (dht_status == DHT11_OK)
            {
                oled_show_utf8(0, 16, "温度:");
                studio_show_tenths(40, 16, reading.temperature_tenths, 'C');
                oled_show_utf8(0, 32, "湿度:");
                studio_show_tenths(40, 32, reading.humidity_tenths, '%');
                oled_show_utf8(0, 48, "状态:正常");
            }
            else
            {
                oled_show_utf8(0, 16, "传感器异常");
                oled_show_string(0, 40, "CHECK PB1 / VCC", OLED_FONT_8X16);
            }
            oled_status = oled_refresh_checked();
        }

        /* 串口报告的是本次驱动读取值和通信状态，失败时值为 null。 */
        studio_log_sample(++sample, &reading, dht_status, oled_status);
        HAL_Delay(SAMPLE_INTERVAL_MS < 1000U ? 1000U : SAMPLE_INTERVAL_MS);
    }
}
