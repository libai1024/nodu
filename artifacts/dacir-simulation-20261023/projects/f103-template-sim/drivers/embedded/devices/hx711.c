/* Modified 2026-10-23: generic file and API names; original license retained. */
/* SPDX-License-Identifier: AGPL-3.0-only */
#include "hx711.h"
#include <limits.h>
static int valid(const hx711_t *d){return d&&d->initialized;}
static int selection(hx711_selection_t s){return s==HX711_A128||s==HX711_B32||s==HX711_A64;}
hx711_status_t hx711_init(hx711_t *d,const hx711_io_t *io){
    if(!d||!io||!io->read_dout||!io->set_sck||!io->now_ms||!io->delay_us||!io->critical_enter||!io->critical_exit)return HX711_ARGUMENT;
    hx711_t fresh={0};fresh.io=*io;fresh.initialized=1;
    fresh.active_selection=fresh.requested_selection=fresh.last_selection=HX711_A128;
    fresh.tare_selection=fresh.calibration_selection=HX711_A128;*d=fresh;
    d->io.set_sck(d->io.user,0);return HX711_OK;
}
hx711_status_t hx711_ready(hx711_t *d,int *ready){
    if(!valid(d)||!ready)return HX711_ARGUMENT;
    if(d->powered_down||d->desynchronized)return HX711_STATE;
    int level=d->io.read_dout(d->io.user);if(level<0||level>1)return HX711_IO;
    *ready=!level;return HX711_OK;
}
hx711_status_t hx711_select(hx711_t *d,hx711_selection_t s){
    if(!valid(d)||!selection(s))return HX711_ARGUMENT;
    if(d->powered_down||d->desynchronized)return HX711_STATE;
    d->requested_selection=s;return HX711_OK;
}
hx711_status_t hx711_read_raw(hx711_t *d,int32_t *raw,uint32_t timeout){
    if(!valid(d)||!raw||timeout>60000U)return HX711_ARGUMENT;
    if(d->powered_down||d->desynchronized)return HX711_STATE;
    uint32_t start=d->io.now_ms(d->io.user);int ready=0;hx711_status_t status;
    for(;;){
        status=hx711_ready(d,&ready);if(status!=HX711_OK)return status;
        if(ready)break;
        if((uint32_t)(d->io.now_ms(d->io.user)-start)>=timeout)return HX711_TIMEOUT;
        if(d->io.idle)d->io.idle(d->io.user);
    }
    /* A real READY observation proves the previous selection's conversion has
     * completed. Clear pending before shifting, including mid-frame I/O error
     * paths, so power_down/wake can recover without a permanent STATE loop. */
    d->selection_pending=0;
    /* A1MHz callback may observe a tick partway through.2us requested leaves
     * at least1us and safely exceeds the100ns READY-to-first-clock minimum. */
    uint32_t bits=0;d->io.delay_us(d->io.user,2);
    for(unsigned i=0;i<(unsigned)d->requested_selection;i++){
        uint32_t mask=d->io.critical_enter(d->io.user);
        d->io.set_sck(d->io.user,1);d->io.delay_us(d->io.user,2);
        int bit=i<24?d->io.read_dout(d->io.user):0;
        d->io.set_sck(d->io.user,0);d->io.critical_exit(d->io.user,mask);
        d->io.delay_us(d->io.user,2);
        if(bit<0||bit>1){d->desynchronized=1;return HX711_IO;}
        if(i<24)bits=(bits<<1)|(uint32_t)bit;
    }
    int32_t value=(int32_t)(bits&0x7fffffU);if(bits&0x800000U)value-=8388608;
    d->last_selection=d->active_selection;
    d->selection_pending=d->requested_selection!=d->active_selection;
    d->active_selection=d->requested_selection;d->last_raw=value;++d->sample;*raw=value;return HX711_OK;
}
static hx711_status_t average(hx711_t *d,uint8_t count,uint32_t timeout,int32_t *raw){
    if(!valid(d)||!raw||!count||count>32||timeout>60000U)return HX711_ARGUMENT;
    int64_t sum=0;
    /* Do not combine previous and newly selected gains in one calibration. */
    if(d->requested_selection!=d->active_selection||d->selection_pending)return HX711_STATE;
    for(unsigned i=0;i<count;i++){int32_t v;hx711_status_t s=hx711_read_raw(d,&v,timeout);if(s!=HX711_OK)return s;sum+=v;}
    *raw=(int32_t)(sum/count);return HX711_OK;
}
hx711_status_t hx711_tare(hx711_t *d,uint8_t count,uint32_t timeout){
    int32_t raw;hx711_status_t s=average(d,count,timeout,&raw);if(s!=HX711_OK)return s;
    d->tare_raw=raw;d->tare_selection=d->last_selection;return HX711_OK;
}
hx711_status_t hx711_set_scale_q16(hx711_t *d,int64_t counts){
    if(!valid(d)||!counts||counts>INT64_C(1099511562240000)||counts<-INT64_C(1099511562240000))return HX711_ARGUMENT;
    d->counts_per_gram_q16=counts;d->calibration_selection=d->active_selection;return HX711_OK;
}
hx711_status_t hx711_calibrate(hx711_t *d,int32_t known,uint8_t count,uint32_t timeout){
    if(!valid(d)||known<=0)return HX711_ARGUMENT;
    if(d->tare_selection!=d->active_selection)return HX711_CALIBRATION;
    int32_t raw;hx711_status_t s=average(d,count,timeout,&raw);if(s!=HX711_OK)return s;
    int64_t span=(int64_t)raw-d->tare_raw;if(!span)return HX711_CALIBRATION;
    int64_t scale=span*INT64_C(65536000)/known;if(!scale)return HX711_CALIBRATION;
    d->counts_per_gram_q16=scale;d->calibration_selection=d->last_selection;return HX711_OK;
}
hx711_status_t hx711_mass_mg(const hx711_t *d,int32_t raw,int32_t *mass){
    if(!valid(d)||!mass||raw<-8388608||raw>8388607)return HX711_ARGUMENT;
    if(!d->counts_per_gram_q16||d->last_selection!=d->tare_selection||d->last_selection!=d->calibration_selection)return HX711_CALIBRATION;
    int64_t value=((int64_t)raw-d->tare_raw)*INT64_C(65536000)/d->counts_per_gram_q16;
    if(value<INT32_MIN||value>INT32_MAX)return HX711_OVERFLOW;
    *mass=(int32_t)value;return HX711_OK;
}
hx711_status_t hx711_power_down(hx711_t *d){
    if(!valid(d))return HX711_ARGUMENT;
    if(d->selection_pending)return HX711_STATE;
    if(d->powered_down)return HX711_OK;
    uint32_t mask=d->io.critical_enter(d->io.user);d->io.set_sck(d->io.user,1);
    d->io.delay_us(d->io.user,70);d->io.critical_exit(d->io.user,mask);d->powered_down=1;return HX711_OK;
}
hx711_status_t hx711_wake(hx711_t *d){
    if(!valid(d))return HX711_ARGUMENT;
    if(!d->powered_down)return HX711_STATE;
    d->io.set_sck(d->io.user,0);d->powered_down=0;d->desynchronized=0;return HX711_OK;
}
