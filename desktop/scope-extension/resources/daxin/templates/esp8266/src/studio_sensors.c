/* SPDX-License-Identifier: AGPL-3.0-only
 * 可移植教学参考驱动；引脚由调用方显式传入，和仿真接线无关。
 */
#include "studio.h"
#include "timebase_accumulator.h"
static uint32_t sensor_us(void) {
    static poc_timebase_t state;
    return poc_timebase_sample(&state,SysTick->VAL,SysTick->LOAD,SystemCoreClock/1000000U);
}
static void sensor_delay(uint32_t us) { uint32_t t=sensor_us(); while ((uint32_t)(sensor_us()-t)<us) {} }
static int pin_valid(GPIO_TypeDef *port,uint16_t pin) {
    return (port==GPIOA || port==GPIOB || port==GPIOC) && pin && !(pin & (pin-1));
}
static void sensor_mode(GPIO_TypeDef *port,uint16_t pin,uint32_t mode) {
    unsigned index=0; while (!(pin&(1U<<index))) ++index;
    volatile uint32_t *cr=index<8?&port->CRL:&port->CRH;
    unsigned shift=(index%8)*4;
    *cr=(*cr & ~(15U<<shift)) | (mode<<shift);
}
static void sensor_clocks(void) {
    __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_GPIOB_CLK_ENABLE(); __HAL_RCC_GPIOC_CLK_ENABLE();
}
static void ow_low(GPIO_TypeDef *p,uint16_t pin) { p->BRR=pin; sensor_mode(p,pin,6U); }
static void ow_release(GPIO_TypeDef *p,uint16_t pin) { p->BSRR=pin; sensor_mode(p,pin,8U); }
static int ow_reset(GPIO_TypeDef *p,uint16_t pin) {
    ow_low(p,pin); sensor_delay(480); ow_release(p,pin); sensor_delay(70);
    int present=!(p->IDR&pin); sensor_delay(410); return present;
}
static void ow_write(GPIO_TypeDef *p,uint16_t pin,uint8_t byte) {
    for (unsigned i=0;i<8;++i) {
        ow_low(p,pin); sensor_delay((byte&1)?6:60); ow_release(p,pin);
        sensor_delay((byte&1)?64:10); byte>>=1;
    }
}
static uint8_t ow_read(GPIO_TypeDef *p,uint16_t pin) {
    uint8_t byte=0;
    for (unsigned i=0;i<8;++i) {
        ow_low(p,pin); sensor_delay(6); ow_release(p,pin); sensor_delay(9);
        if (p->IDR&pin) byte|=1U<<i;
        sensor_delay(55);
    }
    return byte;
}
uint8_t studio_ds18b20_read(GPIO_TypeDef *port,uint16_t pin,int32_t *temperature_tenths) {
    if (!pin_valid(port,pin) || !temperature_tenths) return SENSOR_ARGUMENT;
    sensor_clocks(); ow_release(port,pin);
    if (!ow_reset(port,pin)) return SENSOR_TIMEOUT;
    ow_write(port,pin,0xCC); ow_write(port,pin,0x44); HAL_Delay(750);
    if (!ow_reset(port,pin)) return SENSOR_TIMEOUT;
    ow_write(port,pin,0xCC); ow_write(port,pin,0xBE);
    uint8_t scratch[9],crc=0;
    for (unsigned n=0;n<9;++n) scratch[n]=ow_read(port,pin);
    for (unsigned n=0;n<8;++n) {
        uint8_t byte=scratch[n];
        for (unsigned b=0;b<8;++b) { uint8_t mix=(crc^byte)&1; crc>>=1; if(mix)crc^=0x8C; byte>>=1; }
    }
    if (crc!=scratch[8]) return SENSOR_CHECKSUM;
    int16_t raw=(int16_t)((uint16_t)scratch[0]|((uint16_t)scratch[1]<<8));
    *temperature_tenths=(int32_t)raw*10/16;
    return SENSOR_OK;
}
uint8_t studio_hcsr04_read(GPIO_TypeDef *trig_port,uint16_t trig_pin,GPIO_TypeDef *echo_port,uint16_t echo_pin,uint32_t *distance_mm) {
    if (!pin_valid(trig_port,trig_pin)||!pin_valid(echo_port,echo_pin)||!distance_mm) return SENSOR_ARGUMENT;
    sensor_clocks(); trig_port->BRR=trig_pin; sensor_mode(trig_port,trig_pin,2U); sensor_mode(echo_port,echo_pin,4U);
    sensor_delay(2); trig_port->BSRR=trig_pin; sensor_delay(10); trig_port->BRR=trig_pin;
    uint32_t start=sensor_us();
    while (!(echo_port->IDR&echo_pin)) if ((uint32_t)(sensor_us()-start)>30000) return SENSOR_TIMEOUT;
    start=sensor_us();
    while (echo_port->IDR&echo_pin) if ((uint32_t)(sensor_us()-start)>30000) return SENSOR_TIMEOUT;
    *distance_mm=(uint32_t)(sensor_us()-start)*10U/58U;
    return SENSOR_OK;
}
