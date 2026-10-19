/* SPDX-License-Identifier: MIT
 * Copyright (c) 2019 Vowstar
 * Copyright 2026 Nodu contributors.
 *
 * Independent bounded adapter of the public SLIP format used by MIT
 * kflash.py 550828c768b16ef329695d3f5eace3f6bcf14af2; no ktool slip.c/h used.
 * See ../licenses/kflash-MIT.txt for permission and warranty terms.
 */
#include "probe.h"

void probe_slip_clear(probe_slip *state)
{
    state->size = 0;
    state->active = 0;
    state->escaped = 0;
    state->rejected = 0;
}

int probe_slip_feed(probe_slip *state, uint8_t byte)
{
    if (byte == 0xc0) {
        int result = 0;
        if (state->active && (state->size || state->rejected || state->escaped))
            result = (state->rejected || state->escaped) ? -1 : 1;
        state->active = 1;
        state->escaped = 0;
        state->rejected = 0;
        /* Caller consumes frame/size before resetting size. */
        if (!result)
            state->size = 0;
        return result;
    }
    if (!state->active || state->rejected)
        return 0;
    if (state->escaped) {
        state->escaped = 0;
        if (byte == 0xdc)
            byte = 0xc0;
        else if (byte == 0xdd)
            byte = 0xdb;
        else {
            state->rejected = 1;
            return 0;
        }
    } else if (byte == 0xdb) {
        state->escaped = 1;
        return 0;
    }
    if (state->size == PROBE_REQUEST_SIZE) {
        state->rejected = 1;
        return 0;
    }
    state->frame[state->size++] = byte;
    return 0;
}

int probe_slip_send(const uint8_t *data, size_t size,
                    int (*put_byte)(uint8_t byte))
{
    if (size > PROBE_RESPONSE_SIZE || put_byte(0xc0))
        return -1;
    for (size_t i = 0; i < size; ++i) {
        uint8_t byte = data[i];
        if (byte == 0xc0 || byte == 0xdb) {
            if (put_byte(0xdb) || put_byte(byte == 0xc0 ? 0xdc : 0xdd))
                return -1;
        } else if (put_byte(byte))
            return -1;
    }
    return put_byte(0xc0);
}
