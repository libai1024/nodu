/* Modified 2026-10-23: generic file and API names; original license retained. */
#ifndef EMBEDDED_COMMON_INTERRUPTS_H
#define EMBEDDED_COMMON_INTERRUPTS_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "types.h"

/* Exported functions prototypes ---------------------------------------------*/

void interrupt_global_enable       (void);
void interrupt_global_disable      (void);
void interrupt_set_priority_group  (uint32 group);
void interrupt_set_priority        (IRQn_Type irq, uint32 preempt, uint32 sub);
void interrupt_enable              (IRQn_Type irq);
void interrupt_disable             (IRQn_Type irq);
void interrupt_set_pending         (IRQn_Type irq);
void interrupt_clear_pending       (IRQn_Type irq);

#ifdef __cplusplus
}
#endif

#endif /* EMBEDDED_COMMON_INTERRUPTS_H */
