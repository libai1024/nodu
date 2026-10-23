/* SPDX-License-Identifier: AGPL-3.0-only */
#include "studio.h"
#include "console.h"
#undef USART1_IRQHandler

/* Producer = IRQ, consumer = main. 512 bytes covers >40 ms at 115200 baud.
 * No printing, sensor access or parsing happens in interrupt context. */
#define RX_SIZE 512U
static volatile uint8_t rx[RX_SIZE];
static volatile uint16_t head, tail;
static volatile uint32_t errors;
void USART1_IRQHandler(void)
{
    uint32_t status = USART1->SR;
    if (status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE | USART_SR_NE | USART_SR_PE)) {
        uint8_t value = (uint8_t)USART1->DR; /* SR then DR clears hardware flags. */
        if (status & (USART_SR_ORE | USART_SR_FE | USART_SR_NE | USART_SR_PE)) ++errors;
        if (status & USART_SR_RXNE) {
            uint16_t next = (head + 1U) & (RX_SIZE - 1U);
            if (next == tail) ++errors;
            else { rx[head] = value; __DMB(); head = next; }
        }
    }
}
void console_init(void)
{
    head = tail = 0; errors = 0;
    uint32_t status = USART1->SR;
    if (status & (USART_SR_RXNE | USART_SR_ORE | USART_SR_FE | USART_SR_NE | USART_SR_PE))
        (void)USART1->DR;
    NVIC_SetPriority(USART1_IRQn, 2);
    NVIC_EnableIRQ(USART1_IRQn);
    USART1->CR1 |= USART_CR1_RXNEIE;
}
int console_read(void)
{
    if (tail == head) return -1;
    uint8_t value = rx[tail];
    __DMB(); tail = (tail + 1U) & (RX_SIZE - 1U);
    return value;
}
uint32_t console_errors(void) { return errors; }
uint32_t console_flush(void)
{
    uint32_t masked = __get_PRIMASK();
    __disable_irq();
    tail = head; __DMB();
    uint32_t generation = errors;
    if (!masked) __enable_irq();
    return generation;
}
void console_number(uint32_t value)
{
    char buffer[11], reverse[10]; unsigned i = 0, j = 0;
    do { reverse[j++] = '0' + value % 10; value /= 10; } while (value);
    while (j) buffer[i++] = reverse[--j];
    buffer[i] = 0; studio_uart_write(buffer);
}
