/* Copyright 2018 Canaan Inc.
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
 * SPI3-only, byte-width adaptation of official SDK V0.5.6 spi_init(),
 * spi_clk_init(), spi_receive_data_standard(); fixed read commands only.
 * Adapted from spi.c at 45642af98f15c24d64703ff57c97360794ca6f55.
 * Added cycle deadlines and unconditional CS/SSI cleanup; no DMA,
 * allocation, generalized SPI API, reset, status-register writes or QE.
 * UARTHS bounded byte operations follow the same SDK's uarths.c registers.
 */
#include "probe.h"
#include "spi.h"
#include "sysctl.h"
#include "fpioa.h"
#include "uarths.h"

#define IO_CYCLE_BUDGET 26000000ull
#define FRAME_CYCLE_BUDGET 13000000ull

static uint64_t cycles(void)
{
    uint64_t value;
    __asm__ volatile("rdcycle %0" : "=r"(value));
    return value;
}

static int expired(uint64_t start)
{
    return cycles() - start >= IO_CYCLE_BUDGET;
}

int probe_spi_init(void)
{
    /* SDK source-select 0 is fixed IN0: no inherited PLL0 state is required.
     * This intentionally differs from spi_clk_init()'s PLL0 selection. */
    sysctl_clock_set_clock_select(SYSCTL_CLOCK_SELECT_SPI3, 0);
    sysctl_clock_enable(SYSCTL_CLOCK_SPI3);
    sysctl_clock_set_threshold(SYSCTL_THRESHOLD_SPI3, 0);
    volatile spi_t *const port = (volatile spi_t *)SPI3_BASE_ADDR;
    port->ser = 0;
    port->ssienr = 0;
    port->imr = 0;
    port->dmacr = 0;
    port->dmatdlr = 0x10;
    port->dmardlr = 0;
    port->ctrlr0 = 7; /* SPI3: 8 bits, standard single line, mode 0. */
    port->spi_ctrlr0 = 0;
    port->endian = 0;
    port->baudr = 512; /* Conservative even divider; never changes Flash state. */
    return 0;
}

static int receive_identity_command(const uint8_t *cmd, size_t command_size,
                                    uint8_t *result, size_t result_size)
{
    /* Guard also narrows this private helper: no generic command injection. */
    if (!((cmd[0] == 0x9f && command_size == 1 && result_size == 3) ||
          (cmd[0] == 0x90 && command_size == 4 && result_size == 2) ||
          (cmd[0] == 0x4b && command_size == 5 && result_size == 8)))
        return -1;
    for (size_t i = 1; i < command_size; ++i)
        if (cmd[i] != 0)
            return -1;

    volatile spi_t *const port = (volatile spi_t *)SPI3_BASE_ADDR;
    uint64_t start = cycles();
    int status = -1;
    port->ser = 0;
    port->ssienr = 0;
    /* SDK EEPROM transfer mode; standard frame format and 8-bit width. */
    port->ctrlr0 = 7u | (3u << 10);
    port->ctrlr1 = (uint32_t)result_size - 1;
    port->ssienr = 1;
    size_t sent = 0;
    while (sent < command_size) {
        uint32_t room = 32u - port->txflr;
        if (room > command_size - sent)
            room = (uint32_t)(command_size - sent);
        for (uint32_t i = 0; i < room; ++i)
            port->dr[0] = cmd[sent++];
        if (expired(start))
            goto cleanup;
    }
    port->ser = 1; /* Dedicated boot Flash, chip select 0. */
    size_t received = 0;
    while (received < result_size) {
        uint32_t available = port->rxflr;
        if (available > result_size - received)
            available = (uint32_t)(result_size - received);
        for (uint32_t i = 0; i < available; ++i)
            result[received++] = (uint8_t)port->dr[0];
        if (expired(start))
            goto cleanup;
    }
    /* Match SDK standard receive: requested bytes complete the transaction.
     * No additional TX-mode SR wait is imposed on this EEPROM receive path. */
    status = 0;
cleanup:
    port->ser = 0;
    port->ssienr = 0;
    return status;
}

int probe_flash_identity(uint8_t jedec[3], uint8_t uid[8], uint8_t legacy[2])
{
    static const uint8_t jedec_command[1] = {0x9f};
    static const uint8_t legacy_command[4] = {0x90, 0, 0, 0};
    static const uint8_t uid_command[5] = {0x4b, 0, 0, 0, 0};
    if (receive_identity_command(jedec_command, 1, jedec, 3))
        return PROBE_JEDEC_TRANSFER_FAILED;
    if (receive_identity_command(legacy_command, 4, legacy, 2))
        return PROBE_LEGACY_TRANSFER_FAILED;
    if (!probe_identity_allowed(jedec, legacy))
        return PROBE_UNSUPPORTED_ID;
    if (receive_identity_command(uid_command, 5, uid, 8))
        return PROBE_UID_TRANSFER_FAILED;
    return 0;
}

static int uart_put_byte(uint8_t byte)
{
    uint64_t start = cycles();
    while (uarths->txdata.full)
        if (expired(start))
            return -1;
    /* TXDATA is a 32-bit APB register: do not emit a bitfield byte store. */
    *(volatile uint32_t *)UARTHS_BASE_ADDR = (uint32_t)byte;
    return 0;
}

void probe_main(void)
{
    /* No fpioa_init(): only the two ROM console pins are mapped. */
    fpioa_set_function(4, FUNC_UARTHS_RX);
    fpioa_set_function(5, FUNC_UARTHS_TX);
    uarths_init();
    uarths->ie.txwm = 0;
    uarths->ie.rxwm = 0;
    uarths->txctrl.nstop = 0;

    probe_context context = {0, probe_spi_init, probe_flash_identity};
    probe_slip parser;
    uint8_t response[PROBE_RESPONSE_SIZE];
    probe_slip_clear(&parser);
    uint64_t last_byte = cycles();
    for (;;) {
        uarths_rxdata_t value = uarths->rxdata;
        if (value.empty) {
            if (parser.active && (parser.size || parser.escaped || parser.rejected) &&
                cycles() - last_byte >= FRAME_CYCLE_BUDGET)
                probe_slip_clear(&parser);
            continue;
        }
        last_byte = cycles();
        int frame = probe_slip_feed(&parser, (uint8_t)value.data);
        if (!frame)
            continue;
        size_t size;
        if (frame < 0) {
            response[0] = PROBE_NOP;
            response[1] = PROBE_BAD_LENGTH;
            size = 2;
        } else {
            size = probe_process(&context, parser.frame, parser.size, response);
        }
        parser.size = 0;
        if (probe_slip_send(response, size, uart_put_byte)) {
            /* UART timeout: fail closed; do not reset or jump anywhere. */
            for (;;)
                __asm__ volatile("wfi");
        }
    }
}
