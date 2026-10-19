/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Nodu contributors.
 */
#ifndef NODU_FLASH_PROBE_H
#define NODU_FLASH_PROBE_H
#include <stddef.h>
#include <stdint.h>

#define PROBE_REQUEST_SIZE 16u
#define PROBE_RESPONSE_SIZE 27u
#define PROBE_NOP 0xd2u
#define PROBE_INIT 0xd7u
#define PROBE_ID 0xdeu
#define PROBE_OK 0xe0u
#define PROBE_BAD_LENGTH 0xe1u
#define PROBE_BAD_CRC 0xe2u
#define PROBE_BAD_COMMAND 0xe3u
#define PROBE_BAD_INIT 0xe4u

typedef struct {
    int initialized;
    int (*init)(void);
    int (*read_identity)(uint8_t jedec[3], uint8_t uid[8]);
} probe_context;

uint32_t probe_crc32(const uint8_t *message, size_t size);
int probe_identity_allowed(const uint8_t jedec[3], const uint8_t legacy[2]);
size_t probe_process(probe_context *context, const uint8_t *request,
                     size_t size, uint8_t response[PROBE_RESPONSE_SIZE]);

typedef struct {
    uint8_t frame[PROBE_REQUEST_SIZE];
    size_t size;
    int active;
    int escaped;
    int rejected;
} probe_slip;
/* Returns 0 for incomplete, 1 for a frame, -1 for a rejected frame. */
int probe_slip_feed(probe_slip *state, uint8_t byte);
void probe_slip_clear(probe_slip *state);
int probe_slip_send(const uint8_t *data, size_t size,
                    int (*put_byte)(uint8_t byte));

int probe_spi_init(void);
int probe_flash_identity(uint8_t jedec[3], uint8_t uid[8]);
void probe_main(void) __attribute__((noreturn));
#endif
