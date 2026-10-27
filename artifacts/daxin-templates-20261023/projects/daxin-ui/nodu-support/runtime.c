#include <stddef.h>
/* Minimal freestanding support: no hosted C library or semihosting required. */
void __libc_init_array(void) {}
void *memset(void *dst, int value, size_t n) { unsigned char *d = dst; while(n--) *d++ = (unsigned char)value; return dst; }
void *memcpy(void *dst, const void *src, size_t n) { unsigned char *d=dst; const unsigned char *s=src; while(n--) *d++=*s++; return dst; }
