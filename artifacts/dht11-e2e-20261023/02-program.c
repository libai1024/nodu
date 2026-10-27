/* SPDX-License-Identifier: AGPL-3.0-only
 * STM32F103C8T6: DHT11 DATA=PB0, USART1 PA9/PA10, 115200 8N1.
 */
#include "studio.h"
#define SAMPLE_MS 2000U

static void print_uint(uint32_t value)
{
    char text[11];
    unsigned index = sizeof(text) - 1U;
    text[index] = 0;
    do { text[--index] = (char)('0' + value % 10U); value /= 10U; } while (value);
    studio_uart_write(&text[index]);
}

static void print_tenths(int32_t value)
{
    if (value < 0) { studio_uart_write("-"); value = -value; }
    print_uint((uint32_t)value / 10U);
    studio_uart_write(".");
    print_uint((uint32_t)value % 10U);
}

int main(void)
{
    studio_board_init();
    dht11_config(GPIOB, GPIO_PIN_0);
    dht11_init();
    studio_uart_write("NODU_DHT11 v1 MCU=STM32F103C8T6 DATA=PB0 UART=115200,8N1\r\n");
    HAL_Delay(1000);
    uint32_t sequence = 0;
    uint32_t last_sample = HAL_GetTick() - SAMPLE_MS;
    for (;;)
    {
        int received;
        while ((received = studio_uart_read()) >= 0)
            if (received == '?') studio_uart_write("ACK NODU_DHT11 v1\r\n");
        if ((uint32_t)(HAL_GetTick() - last_sample) >= SAMPLE_MS)
        {
            last_sample = HAL_GetTick();
            dht11_reading_t reading = {0};
            uint8_t status = dht11_read(&reading);
            studio_uart_write("sample="); print_uint(++sequence);
            studio_uart_write(" uptime_ms="); print_uint(HAL_GetTick());
            if (status == DHT11_OK)
            {
                studio_uart_write(" temperature="); print_tenths(reading.temperature_tenths);
                studio_uart_write(" C humidity="); print_tenths(reading.humidity_tenths);
                studio_uart_write("%RH status=OK\r\n");
            }
            else
            {
                studio_uart_write(" DHT11_ERROR="); print_uint(status);
                studio_uart_write("\r\n");
            }
        }
        HAL_Delay(10);
    }
}
