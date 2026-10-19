/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Nodu contributors.
 * Host-only safety tests; no MMIO, serial or RISC-V output execution.
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "src/probe.h"

static unsigned int init_calls, read_calls;
static int init_fail, read_fail;
static int init_fake(void) { ++init_calls; return init_fail; }
static int read_fake(uint8_t id[3], uint8_t uid[8])
{
    ++read_calls;
    id[0] = 0xef; id[1] = 0x40; id[2] = 0x18;
    for (unsigned int i = 0; i < 8; ++i) uid[i] = (uint8_t)i;
    return read_fail;
}
static void put32(uint8_t *p, uint32_t n)
{
    for (unsigned int i = 0; i < 4; ++i) p[i] = (uint8_t)(n >> (8 * i));
}
static uint32_t get32(const uint8_t *p)
{
    uint32_t n = 0;
    for (unsigned int i = 0; i < 4; ++i) n |= (uint32_t)p[i] << (8 * i);
    return n;
}
static void request(uint8_t *p, uint8_t op)
{
    memset(p, 0, 64);
    p[0] = op;
    put32(p + 4, probe_crc32(p + 8, 8));
}
static uint8_t encoded[64];
static size_t encoded_size;
static int put_byte(uint8_t byte)
{
    assert(encoded_size < sizeof(encoded));
    encoded[encoded_size++] = byte;
    return 0;
}
static int reject_byte(uint8_t byte) { (void)byte; return -1; }

int main(void)
{
    assert(probe_crc32((const uint8_t *)"123456789", 9) == 0xcbf43926u);
    uint8_t req[64], out[PROBE_RESPONSE_SIZE];
    probe_context context = {0, init_fake, read_fake};
    for (unsigned int op = 0; op < 256; ++op) {
        if (op == PROBE_NOP || op == PROBE_INIT || op == PROBE_ID) continue;
        request(req, (uint8_t)op);
        assert(probe_process(&context, req, 16, out) == 2);
        assert(out[0] == op && out[1] == PROBE_BAD_COMMAND);
    }
    assert(init_calls == 0 && read_calls == 0);
    for (size_t size = 0; size < sizeof(req); ++size) {
        if (size == 16) continue;
        request(req, PROBE_INIT);
        assert(probe_process(&context, req, size, out) == 2);
        assert(out[1] == PROBE_BAD_LENGTH);
    }
    for (unsigned int byte = 0; byte < 16; ++byte) {
        if (byte == 0) continue;
        request(req, PROBE_INIT);
        req[byte] ^= 1;
        assert(probe_process(&context, req, 16, out) == 2);
        assert(out[1] != PROBE_OK);
    }
    assert(init_calls == 0 && read_calls == 0);
    request(req, PROBE_ID);
    assert(probe_process(&context, req, 16, out) == 2);
    assert(out[1] == PROBE_BAD_INIT && read_calls == 0);
    request(req, PROBE_INIT);
    init_fail = 1;
    assert(probe_process(&context, req, 16, out) == 2);
    assert(out[1] == PROBE_BAD_INIT && context.initialized == 0);
    init_fail = 0;
    assert(probe_process(&context, req, 16, out) == 2 && out[1] == PROBE_OK);
    unsigned int calls = init_calls;
    assert(probe_process(&context, req, 16, out) == 2 && out[1] == PROBE_OK);
    assert(init_calls == calls && context.initialized == 1);
    request(req, PROBE_ID);
    assert(probe_process(&context, req, 16, out) == 27);
    assert(out[0] == PROBE_ID && out[1] == 0 && out[2] == 0 && out[3] == 0);
    assert(get32(out + 8) == 0 && get32(out + 12) == 0);
    assert(get32(out + 4) == probe_crc32(out + 8, 19));
    assert(out[16] == 0xef && out[18] == 0x18 && out[26] == 7);
    read_fail = 1;
    assert(probe_process(&context, req, 16, out) == 2 && out[1] == PROBE_BAD_INIT);
    for (unsigned int i = 2; i < 27; ++i) assert(out[i] == 0);

    uint8_t id[] = {0xef, 0x40, 0x18}, old[] = {0xef, 0x17};
    assert(probe_identity_allowed(id, old));
    id[1] = 0x70; assert(probe_identity_allowed(id, old)); id[1] = 0x40;
    for (unsigned int byte = 0; byte < 3; ++byte)
        for (unsigned int bit = 0; bit < 8; ++bit) {
            id[byte] ^= (uint8_t)(1u << bit);
            assert(!probe_identity_allowed(id, old));
            id[byte] ^= (uint8_t)(1u << bit);
        }
    for (unsigned int byte = 0; byte < 2; ++byte)
        for (unsigned int bit = 0; bit < 8; ++bit) {
            old[byte] ^= (uint8_t)(1u << bit);
            assert(!probe_identity_allowed(id, old));
            old[byte] ^= (uint8_t)(1u << bit);
        }

    probe_slip parser;
    probe_slip_clear(&parser);
    assert(probe_slip_feed(&parser, 0xde) == 0 && parser.size == 0);
    uint8_t payload[16] = {0xc0, 0xdb, 0, 0xde};
    encoded_size = 0;
    assert(probe_slip_send(payload, sizeof(payload), put_byte) == 0);
    for (size_t i = 0; i < encoded_size - 1; ++i)
        assert(probe_slip_feed(&parser, encoded[i]) == 0);
    assert(probe_slip_feed(&parser, encoded[encoded_size - 1]) == 1);
    assert(parser.size == 16 && memcmp(parser.frame, payload, 16) == 0);
    probe_slip_clear(&parser);
    probe_slip_feed(&parser, 0xc0);
    for (unsigned int i = 0; i < 17; ++i) probe_slip_feed(&parser, 0x42);
    assert(probe_slip_feed(&parser, 0xc0) == -1);
    probe_slip_clear(&parser);
    probe_slip_feed(&parser, 0xc0); probe_slip_feed(&parser, 0xdb);
    probe_slip_feed(&parser, 0x42);
    assert(probe_slip_feed(&parser, 0xc0) == -1);
    probe_slip_clear(&parser);
    probe_slip_feed(&parser, 0xc0); probe_slip_feed(&parser, 0xdb);
    assert(probe_slip_feed(&parser, 0xc0) == -1);
    assert(probe_slip_send(payload, 28, put_byte) == -1);
    assert(probe_slip_send(payload, 16, reject_byte) == -1);
    puts("PASS: CRC, exhaustive forbidden opcodes, malformed/short requests, initialization gate, fixed DE response, partial identity rejection, whitelist mutations, bounded SLIP/escapes/TX failures");
    return 0;
}
