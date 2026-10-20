/* Copyright 2020 LoBo
 * Copyright 2026 Nodu contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * CRC32 and D2/D7/DE packet semantics adapted from ktool main.c at
 * 0345aa90d9b3830641373fb4e3ce4edf45d0a46f. Other operations removed;
 * bounded parsing, strict request CRC and identity whitelist added.
 */
#include "probe.h"

static uint32_t get_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void put_u32(uint8_t *p, uint32_t value)
{
    for (unsigned int i = 0; i < 4; ++i)
        p[i] = (uint8_t)(value >> (i * 8));
}

uint32_t probe_crc32(const uint8_t *message, size_t size)
{
    uint32_t crc = 0xffffffffu;
    while (size != 0) {
        crc ^= *message++;
        for (int j = 7; j >= 0; --j) {
            uint32_t mask = (uint32_t)-(int32_t)(crc & 1u);
            crc = (crc >> 1) ^ (0xedb88320u & mask);
        }
        --size;
    }
    return ~crc;
}

int probe_identity_allowed(const uint8_t jedec[3], const uint8_t legacy[2])
{
    return jedec[0] == 0xef &&
           (jedec[1] == 0x40 || jedec[1] == 0x60 || jedec[1] == 0x70) &&
           jedec[2] == 0x18 &&
           legacy[0] == 0xef && legacy[1] == 0x17;
}

size_t probe_process(probe_context *context, const uint8_t *request,
                     size_t size, uint8_t response[PROBE_RESPONSE_SIZE])
{
    uint8_t op = size ? request[0] : PROBE_NOP;
    response[0] = op;
    response[1] = PROBE_BAD_LENGTH;
    if (size != PROBE_REQUEST_SIZE)
        return 2;
    if (request[1] || request[2] || request[3] || get_u32(request + 8) ||
        get_u32(request + 12)) {
        response[1] = PROBE_BAD_COMMAND;
        return 2;
    }
    if (get_u32(request + 4) != probe_crc32(request + 8, 8)) {
        response[1] = PROBE_BAD_CRC;
        return 2;
    }
    switch (op) {
    case PROBE_NOP:
        response[1] = PROBE_OK;
        return 2;
    case PROBE_INIT:
        if (!context->initialized && context->init() != 0) {
            response[1] = PROBE_BAD_INIT;
            return 2;
        }
        context->initialized = 1;
        response[1] = PROBE_OK;
        return 2;
    case PROBE_ID:
        if (!context->initialized) {
            response[1] = PROBE_BAD_INIT;
            return 2;
        }
        for (size_t i = 0; i < PROBE_RESPONSE_SIZE; ++i)
            response[i] = 0;
        response[0] = PROBE_ID;
        int result = context->read_identity(response + 16, response + 19);
        if (result != 0) {
            /* Never emit a partially populated identity after a failure. */
            for (size_t i = 2; i < PROBE_RESPONSE_SIZE; ++i)
                response[i] = 0;
            /* Only these fixed, non-payload diagnostics can leave the stub. */
            response[1] = (result >= (int)PROBE_JEDEC_TRANSFER_FAILED &&
                           result <= (int)PROBE_UID_TRANSFER_FAILED)
                              ? (uint8_t)result : PROBE_BAD_INIT;
            return 2;
        }
        /* ktool DE is fixed 27 bytes with data_len kept at zero. */
        put_u32(response + 4, probe_crc32(response + 8, 19));
        return PROBE_RESPONSE_SIZE;
    default:
        response[1] = PROBE_BAD_COMMAND;
        return 2;
    }
}
