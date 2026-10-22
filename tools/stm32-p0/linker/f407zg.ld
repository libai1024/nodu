MEMORY
{
  FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 1024K
  RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 128K
  CCM (xrw) : ORIGIN = 0x10000000, LENGTH = 64K
}
/* CCM is deliberately not used as ordinary DMA RAM or default stack. */
INCLUDE common.ld
