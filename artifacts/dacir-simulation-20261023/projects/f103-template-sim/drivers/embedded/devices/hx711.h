/* Modified 2026-10-23: generic file and API names; original license retained. */
/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 STM32 Study Studio contributors.
 * Portable HX711 V2.0 driver. No simulator, MCU, allocation or host answer path.
 */
#ifndef EMBEDDED_DEVICES_HX711_H
#define EMBEDDED_DEVICES_HX711_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef enum { HX711_OK=0, HX711_ARGUMENT, HX711_TIMEOUT, HX711_IO,
               HX711_STATE, HX711_CALIBRATION, HX711_OVERFLOW } hx711_status_t;
/* The count is the TOTAL clock count, including 24 data bits. Selection is for
 * the NEXT conversion. A frame read after select still has its previous gain. */
typedef enum { HX711_A128=25, HX711_B32=26, HX711_A64=27 } hx711_selection_t;
typedef struct {
    void *user;
    int (*read_dout)(void *user); /* actual GPIO:0/1; -1 transport error */
    void (*set_sck)(void *user,int high); /* actual GPIO, initialized low */
    uint32_t (*now_ms)(void *user); /* monotonic modulo2^32; must advance */
    void (*delay_us)(void *user,uint32_t us); /* measured microsecond delay */
    uint32_t (*critical_enter)(void *user); /* save interrupt mask */
    void (*critical_exit)(void *user,uint32_t mask); /* restore saved mask */
    void (*idle)(void *user); /* optional IRQ-enabled wait; must return */
} hx711_io_t;
typedef struct {
    hx711_io_t io;
    int32_t tare_raw,last_raw;
    int64_t counts_per_gram_q16;
    uint32_t sample;
    hx711_selection_t active_selection,requested_selection,last_selection;
    hx711_selection_t tare_selection,calibration_selection;
    uint8_t initialized,powered_down,desynchronized,selection_pending;
} hx711_t;

/* Cold-start state is A/128. Initialize GPIO modes before init. init drives SCK
 * low; it does not pretend to reset an already running external converter.
 * io callbacks except idle are required. All operations run in thread context.
 * Each instance has separate I/O, samples, tare and calibration.
 */
hx711_status_t hx711_init(hx711_t *device,const hx711_io_t *io);
/* Nonblocking ready: only reads physical DOUT, no clocks, no sample consumed. */
hx711_status_t hx711_ready(hx711_t *device,int *ready);
/* timeout_ms=0 is nonblocking, maximum60000ms. Output unchanged on failure.
 * 24 bits MSB-first, signed two's-complement extended to int32_t.
 * Each SCK high/low is2us. Interrupt masking covers only one high pulse. The
 * delay callback must honor2us; waiting for ready leaves interrupts enabled.
 * READY data is read as stored by the actual chip; no software mass shortcut.
 */
hx711_status_t hx711_read_raw(hx711_t *device,int32_t *raw,uint32_t timeout_ms);
hx711_status_t hx711_select(hx711_t *device,hx711_selection_t selection);
/* Real samples,1..32; timeout applies PER sample. All-or-nothing tare update. */
hx711_status_t hx711_tare(hx711_t *device,uint8_t samples,uint32_t timeout_ms);
/* Set known counts/g in signed Q16 units; e.g. ideal2mV/V,5kg,A128 gives
 * 56294995 (~858.993459 counts/g). This is a sensor calibration assumption.
 * Calibration is tied to the current selection; mass conversion on another
 * gain/channel requires a new valid tare/calibration rather than reusing it.
 */
hx711_status_t hx711_set_scale_q16(hx711_t *device,int64_t counts_per_gram_q16);
/* Read actual samples and known MASS IN MILLIGRAMS>0. Reject zero mass/span.
 * Error preserves old scale and tare; negative span is allowed for an inverted
 * sensor signal. This function cannot know whether the physical mass is valid.
 */
hx711_status_t hx711_calibrate(hx711_t *device,int32_t known_mass_mg,uint8_t samples,uint32_t timeout_ms);
/* Convert a raw sample of last_selection using saved tare and calibration.
 * Returns signed mg, including meaningful negatives; output unchanged on error.
 */
hx711_status_t hx711_mass_mg(const hx711_t *device,int32_t raw,int32_t *mass_mg);
/* Hold actual SCK high70us (>60us), then keep high. Reject an uncompleted gain
 * change: read the new setting's first valid frame before power-down so HX711
 * V2.0 can retain that setting. wake drives low and preserves selection; actual
 * chip readiness/settling is still observed via DOUT, not a fabricated delay.
 * A mid-frame callback error desynchronizes reads; power_down/wake recovers.
 */
hx711_status_t hx711_power_down(hx711_t *device);
hx711_status_t hx711_wake(hx711_t *device);

#ifdef __cplusplus
}
#endif
#endif
