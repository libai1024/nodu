/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Nodu contributors.
 * Minimal endpoint for the unmodified official Kendryte V0.5.6 crt.S.
 */
#include <stdint.h>
#include "probe.h"

static void park(void) __attribute__((noreturn));
static void park(void)
{
    __asm__ volatile("csrci mstatus, 8\ncsrw mie, zero" ::: "memory");
    for (;;)
        __asm__ volatile("wfi");
}

void _init_bsp(uint64_t hart_id) __attribute__((noreturn));
void _init_bsp(uint64_t hart_id)
{
    __asm__ volatile("csrci mstatus, 8\ncsrw mie, zero" ::: "memory");
    if (hart_id != 0)
        park();
    extern uint64_t _bss, _ebss;
    for (volatile uint64_t *p = &_bss; p < &_ebss; ++p)
        *p = 0;
    __asm__ volatile("fence rw, rw" ::: "memory");
    probe_main();
}

uint64_t handle_irq(uint64_t cause, uint64_t epc, uint64_t *regs,
                    uint64_t *fpregs)
{
    (void)cause; (void)epc; (void)regs; (void)fpregs;
    park();
}

uint64_t handle_syscall(uint64_t cause, uint64_t epc, uint64_t *regs,
                        uint64_t *fpregs)
{
    (void)cause; (void)epc; (void)regs; (void)fpregs;
    park();
}
