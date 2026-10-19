/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Nodu contributors.
 * Official SDK crt.S stack contract: tp=align64(_end), 32 KiB per hart.
 */
OUTPUT_ARCH("riscv")
ENTRY(_start)
MEMORY { ram (rwx) : ORIGIN = 0x80000000, LENGTH = 128K }
SECTIONS {
  .text : { KEEP(*(.text.start)) *(.text .text.*) } >ram
  .rodata : { *(.rodata .rodata.* .srodata .srodata.*) } >ram
  .data : {
    . = ALIGN(8);
    *(.data .data.*)
    __global_pointer$ = . + 0x800;
    *(.sdata .sdata.*)
  } >ram
  .bss (NOLOAD) : {
    . = ALIGN(8);
    _bss = .;
    *(.bss .bss.* .sbss .sbss.* COMMON)
    . = ALIGN(8);
    _ebss = .;
  } >ram
  . = ALIGN(64);
  _end = .;
  _hart0_stack_top = _end + 32768;
  _hart1_stack_top = _end + 65536;
  ASSERT(_hart1_stack_top <= ORIGIN(ram) + LENGTH(ram), "probe stacks exceed RAM allocation")
  /DISCARD/ : { *(.comment .note.* .eh_frame .eh_frame_hdr) }
}
