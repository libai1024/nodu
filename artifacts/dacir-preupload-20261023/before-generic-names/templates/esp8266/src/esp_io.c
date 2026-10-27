/* SPDX-License-Identifier: AGPL-3.0-only
 * Hardware-only USART adapter. There is no simulated-success path.
 * USART1 PA9/PA10 is the console; USART2 PA2/PA3 (or USART3 PB10/PB11) is ESP.
 */
#include "studio.h"
#include "esp_io.h"
#undef USART1_IRQHandler
#undef USART2_IRQHandler
#undef USART3_IRQHandler
#define RX_SIZE 1024u
typedef struct { volatile uint8_t bytes[RX_SIZE]; volatile uint16_t head, tail; volatile uint32_t errors; uint32_t reported; } ring_t;
static ring_t console_rx, esp_rx;
static USART_TypeDef *const peripheral = ESP_UART3 ? USART3 : USART2;
static void irq(USART_TypeDef *uart, ring_t *ring)
{
    uint32_t status = uart->SR;
    if (status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE | USART_SR_NE | USART_SR_PE)) {
        uint8_t byte = (uint8_t)uart->DR;
        if (status & (USART_SR_ORE | USART_SR_FE | USART_SR_NE | USART_SR_PE)) ++ring->errors;
        if (status & USART_SR_RXNE) {
            uint16_t next = (ring->head + 1u) & (RX_SIZE - 1u);
            if (next == ring->tail) ++ring->errors;
            else { ring->bytes[ring->head] = byte; __DMB(); ring->head = next; }
        }
    }
}
void USART1_IRQHandler(void) { irq(USART1, &console_rx); }
void USART2_IRQHandler(void) { if (!ESP_UART3) irq(USART2, &esp_rx); }
void USART3_IRQHandler(void) { if (ESP_UART3) irq(USART3, &esp_rx); }
static int read_ring(ring_t *ring)
{
    if (ring->reported != ring->errors) { ring->reported = ring->errors; return -2; }
    if (ring->head == ring->tail) return -1;
    uint8_t byte = ring->bytes[ring->tail]; __DMB(); ring->tail = (ring->tail + 1u) & (RX_SIZE - 1u); return byte;
}
static int read_esp(void *user) { (void)user; return read_ring(&esp_rx); }
int esp_console_read(void) { return read_ring(&console_rx); }
uint32_t esp_io_errors(void) { return esp_rx.errors + console_rx.errors; }
static uint32_t millis(void *user) { (void)user; return HAL_GetTick(); }
static int write_esp(void *user, const uint8_t *bytes, size_t length)
{
    (void)user;
    for (size_t i = 0; i < length; ++i) {
        uint32_t start = HAL_GetTick();
        while (!(peripheral->SR & USART_SR_TXE)) if ((uint32_t)(HAL_GetTick() - start) >= 20) return 0;
        peripheral->DR = bytes[i];
    }
    return 1;
}
esp8266_io_t esp_io_callbacks(void)
{ esp8266_io_t io = {0, write_esp, read_esp, millis, 0}; return io; }
void esp_io_reset_module(void)
{
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_4, GPIO_PIN_RESET); HAL_Delay(20);
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_4, GPIO_PIN_SET); HAL_Delay(1000);
    uint32_t masked = __get_PRIMASK(); __disable_irq();
    esp_rx.tail = esp_rx.head; esp_rx.reported = esp_rx.errors; __DMB();
    if (!masked) __enable_irq();
}
void esp_io_init(void)
{
    __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_GPIOB_CLK_ENABLE(); __HAL_RCC_AFIO_CLK_ENABLE();
    if (ESP_UART3) __HAL_RCC_USART3_CLK_ENABLE(); else __HAL_RCC_USART2_CLK_ENABLE();
    GPIO_InitTypeDef gpio = {0}; gpio.Pin = ESP_UART3 ? GPIO_PIN_10 : GPIO_PIN_2;
    gpio.Mode = GPIO_MODE_AF_PP; gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(ESP_UART3 ? GPIOB : GPIOA, &gpio);
    gpio.Pin = ESP_UART3 ? GPIO_PIN_11 : GPIO_PIN_3; gpio.Mode = GPIO_MODE_INPUT; gpio.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(ESP_UART3 ? GPIOB : GPIOA, &gpio);
    /* Explicitly choose non-remapped pins; the circuit never alters this code. */
    if (ESP_UART3) AFIO->MAPR &= ~AFIO_MAPR_USART3_REMAP; else AFIO->MAPR &= ~AFIO_MAPR_USART2_REMAP;
    peripheral->CR1 = 0; peripheral->CR2 = 0; peripheral->CR3 = 0;
    peripheral->BRR = (HAL_RCC_GetPCLK1Freq() + ESP_BAUD / 2u) / ESP_BAUD;
    peripheral->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE;
    NVIC_SetPriority(ESP_UART3 ? USART3_IRQn : USART2_IRQn, 1);
    NVIC_EnableIRQ(ESP_UART3 ? USART3_IRQn : USART2_IRQn);
    (void)USART1->SR; (void)USART1->DR;
    NVIC_SetPriority(USART1_IRQn, 2); NVIC_EnableIRQ(USART1_IRQn); USART1->CR1 |= USART_CR1_RXNEIE;
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_4, GPIO_PIN_SET);
    gpio.Pin = GPIO_PIN_4; gpio.Mode = GPIO_MODE_OUTPUT_PP; gpio.Pull = GPIO_NOPULL; HAL_GPIO_Init(GPIOA, &gpio);
    gpio.Pin = GPIO_PIN_13; HAL_GPIO_Init(GPIOB, &gpio); HAL_GPIO_WritePin(GPIOB, GPIO_PIN_13, GPIO_PIN_RESET);
}
void esp_number(uint32_t value)
{
    char text[11], reverse[10]; unsigned n=0, i=0;
    do { reverse[n++] = '0' + value % 10; value /= 10; } while (value);
    while (n) text[i++] = reverse[--n];
    text[i] = 0; studio_uart_write(text);
}
