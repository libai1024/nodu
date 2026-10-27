/* SPDX-License-Identifier: AGPL-3.0-only
 * Board support and DHT11 reference driver, independent of simulation engines.
 * The upstream NUN library has no DHT11 driver; OLED is NUN Studio v0.1.0.
 */
#include "studio.h"
#include "timebase_accumulator.h"

static void uart_char(char ch)
{
    uint32_t budget = 1000000;
    while (!(USART1->SR & USART_SR_TXE) && --budget) {}
    if (budget) USART1->DR = (uint8_t)ch;
}
static void uart_text(const char *s) { while (*s) uart_char(*s++); }
static void uart_unsigned(uint32_t value)
{
    char text[10]; unsigned count = 0;
    do { text[count++] = (char)('0' + value % 10); value /= 10; } while (value);
    while (count) uart_char(text[--count]);
}
static void uart_signed(int32_t value)
{
    if (value < 0) { uart_char('-'); uart_unsigned((uint32_t)(-(int64_t)value)); }
    else uart_unsigned((uint32_t)value);
}
__attribute__((weak)) void SysTick_Handler(void) { HAL_IncTick(); }
__attribute__((weak)) void HardFault_Handler(void)
{
    uart_text("{\"case\":\"demo_climate\",\"event\":\"hardfault\"}\r\n");
    while (1) {}
}
void studio_board_init(void)
{
    HAL_Init();
    RCC_OscInitTypeDef oscillator = {0};
    oscillator.OscillatorType = RCC_OSCILLATORTYPE_HSE;
    oscillator.HSEState = RCC_HSE_ON;
    oscillator.HSEPredivValue = RCC_HSE_PREDIV_DIV1;
    oscillator.HSIState = RCC_HSI_ON;
    oscillator.PLL.PLLState = RCC_PLL_ON;
    oscillator.PLL.PLLSource = RCC_PLLSOURCE_HSE;
    oscillator.PLL.PLLMUL = RCC_PLL_MUL9;
    HAL_StatusTypeDef oscillator_status = HAL_RCC_OscConfig(&oscillator);
    RCC_ClkInitTypeDef clock = {0};
    clock.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK |
                     RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    clock.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    clock.AHBCLKDivider = RCC_SYSCLK_DIV1;
    clock.APB1CLKDivider = RCC_HCLK_DIV2;
    clock.APB2CLKDivider = RCC_HCLK_DIV1;
    HAL_StatusTypeDef clock_status = oscillator_status == HAL_OK
        ? HAL_RCC_ClockConfig(&clock, FLASH_LATENCY_2) : oscillator_status;
    SystemCoreClockUpdate();
    __HAL_RCC_ADC_CONFIG(RCC_ADCPCLK2_DIV6);
    __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_USART1_CLK_ENABLE();
    __HAL_RCC_AFIO_CLK_ENABLE();
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = GPIO_PIN_9; gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH; HAL_GPIO_Init(GPIOA, &gpio);
    gpio.Pin = GPIO_PIN_10; gpio.Mode = GPIO_MODE_INPUT;
    gpio.Pull = GPIO_NOPULL; HAL_GPIO_Init(GPIOA, &gpio);
    USART1->CR1 = 0; USART1->CR2 = 0; USART1->CR3 = 0;
    USART1->BRR = (HAL_RCC_GetPCLK2Freq() + 57600U) / 115200U;
    USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;
    if (clock_status != HAL_OK || SystemCoreClock != 72000000U)
    {
        uart_text("{\"case\":\"demo_climate\",\"event\":\"clock_error\"}\r\n");
        while (1) {}
    }
    uart_text("{\"case\":\"demo_climate\",\"event\":\"ready\",\"clock_hz\":72000000}\r\n");
}

/* Relative SysTick deltas remain monotonic across reloads. Call at least once
 * per millisecond inside each timed transaction; HAL_Delay gaps are harmless. */
static uint32_t micros(void)
{
    static poc_timebase_t state;
    return poc_timebase_sample(&state, SysTick->VAL, SysTick->LOAD,
                               SystemCoreClock / 1000000U);
}
static void delay_us(uint32_t duration)
{
    uint32_t start = micros();
    while ((uint32_t)(micros() - start) < duration) {}
}
static GPIO_TypeDef *dht_port = GPIOB;
static uint16_t dht_pin = GPIO_PIN_1;
void dht11_config(GPIO_TypeDef *port, uint16_t pin)
{
    if ((port != GPIOA && port != GPIOB && port != GPIOC) || !pin || (pin & (pin-1))) return;
    dht_port = port; dht_pin = pin;
}
static void dht_mode(uint32_t mode)
{
    unsigned index=0; while (!(dht_pin & (1U<<index))) ++index;
    volatile uint32_t *cr=index<8?&dht_port->CRL:&dht_port->CRH;
    unsigned shift=(index%8)*4;
    *cr=(*cr & ~(15U<<shift)) | (mode<<shift);
}
static int wait_level(int high, uint32_t timeout)
{
    uint32_t start = micros();
    while (((dht_port->IDR & dht_pin) != 0) != high)
        if ((uint32_t)(micros() - start) > timeout) return 0;
    return 1;
}
static void data_low(void)
{
    dht_port->BRR = dht_pin;
    dht_mode(6U);
}
static void data_release(void)
{
    dht_port->BSRR = dht_pin;
    dht_mode(8U);
}
void dht11_init(void) { __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_GPIOB_CLK_ENABLE(); __HAL_RCC_GPIOC_CLK_ENABLE(); data_release(); }
uint8_t dht11_read(dht11_reading_t *reading)
{
    uint8_t bytes[5] = {0};
    if (!reading) return DHT11_RANGE;
    data_low(); delay_us(18000); data_release();
    if (!wait_level(0, 200) || !wait_level(1, 120) || !wait_level(0, 120))
        return DHT11_TIMEOUT;
    for (unsigned bit = 0; bit < 40; ++bit)
    {
        if (!wait_level(1, 120)) return DHT11_TIMEOUT;
        uint32_t start = micros();
        if (!wait_level(0, 120)) return DHT11_TIMEOUT;
        bytes[bit / 8] = (uint8_t)((bytes[bit / 8] << 1) |
                                  ((uint32_t)(micros() - start) > 45));
    }
    if ((uint8_t)(bytes[0] + bytes[1] + bytes[2] + bytes[3]) != bytes[4])
        return DHT11_CHECKSUM;
    if (bytes[0] > 100 || bytes[2] > 80 || bytes[1] > 9 || bytes[3] > 9)
        return DHT11_RANGE;
    reading->humidity_tenths = bytes[0] * 10U + bytes[1];
    reading->temperature_tenths = bytes[2] * 10U + bytes[3];
    return DHT11_OK;
}
void studio_show_tenths(uint8_t x, uint8_t y, int32_t value, char unit)
{
    char text[15], digits[10]; unsigned index = 0, count = 0;
    uint32_t magnitude = value < 0 ? (uint32_t)(-(int64_t)value) : (uint32_t)value;
    if (value < 0) text[index++] = '-';
    uint32_t whole = magnitude / 10;
    do { digits[count++] = (char)('0' + whole % 10); whole /= 10; } while (whole);
    while (count) text[index++] = digits[--count];
    text[index++] = '.'; text[index++] = (char)('0' + magnitude % 10);
    text[index++] = unit; text[index] = 0;
    oled_show_string(x, y, text, OLED_FONT_8X16);
}
void studio_log_sample(uint32_t sequence, const dht11_reading_t *reading,
                       uint8_t dht_status, uint8_t oled_status)
{
    uart_text("{\"case\":\"demo_climate\",\"event\":\"sample\",\"sample\":");
    uart_unsigned(sequence); uart_text(",\"uptime_ms\":"); uart_unsigned(HAL_GetTick());
    uart_text(",\"temperature_tenths\":");
    if (dht_status == DHT11_OK) uart_signed(reading->temperature_tenths); else uart_text("null");
    uart_text(",\"humidity_tenths\":");
    if (dht_status == DHT11_OK) uart_unsigned(reading->humidity_tenths); else uart_text("null");
    uart_text(",\"dht_status\":"); uart_unsigned(dht_status);
    uart_text(",\"oled_status\":"); uart_unsigned(oled_status); uart_text("}\r\n");
}

/* USART1 的收发由固件完成，终端连接不改变本函数的引脚配置。 */
void studio_uart_write(const char *text) { if (text) uart_text(text); }
int studio_uart_read(void) { return (USART1->SR & USART_SR_RXNE) ? (int)(USART1->DR & 255U) : -1; }
