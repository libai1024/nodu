/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef POC_TIMEBASE_ACCUMULATOR_H
#define POC_TIMEBASE_ACCUMULATOR_H
#include <stdint.h>
typedef struct {
    uint32_t previous, microseconds, remainder;
    uint8_t initialized;
} poc_timebase_t;
/* Poll at least once per hardware reload. Store whole microseconds plus a
 * sub-microsecond remainder: a 32-bit cycle accumulator would wrap in 59.65 s
 * at 72 MHz. The returned uint32_t wraps normally at 2^32 microseconds, allowing
 * unsigned relative subtraction for bounded intervals below that duration. */
static inline uint32_t poc_timebase_sample(poc_timebase_t *state,
                                           uint32_t current, uint32_t reload,
                                           uint32_t ticks_per_us) {
    if (!state->initialized) {
        state->previous = current;
        state->initialized = 1;
    }
    uint32_t elapsed = state->previous >= current
        ? state->previous - current : state->previous + reload + 1U - current;
    state->previous = current;
    uint32_t ticks = state->remainder + elapsed;
    state->microseconds += ticks / ticks_per_us;
    state->remainder = ticks % ticks_per_us;
    return state->microseconds;
}
#endif
