/* SPDX-License-Identifier: AGPL-3.0-only
 * DX Teaching 16 lookup API. Glyph data is separately licensed OFL-1.1.
 * See fonts/licenses/NOTICE.md and fonts/licenses/OFL-1.1.txt.
 */
#ifndef DX_COMMON_FONT16_H
#define DX_COMMON_FONT16_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t codepoint;
    /* Page 0 columns 0..15, then page 1 columns 0..15; LSB is top pixel. */
    uint8_t bitmap[32];
} dx_font16_glyph_t;

/* All returned objects have static const storage; missing/out-of-range -> NULL. */
const dx_font16_glyph_t *dx_font16_find(uint32_t codepoint);
uint32_t dx_font16_glyph_count(void);
const dx_font16_glyph_t *dx_font16_get_index(uint32_t index);

/* Decode from a valid NUL-terminated string. Returns 1: scalar, 0: NUL, -1:
 * invalid. Invalid sequences consume exactly one byte and set *cp to U+FFFD;
 * no byte after NUL is read. NUL leaves cursor unchanged and sets *cp to zero.
 * NULL arguments return -1 without reading or modifying anything.
 */
int dx_utf8_next(const char **cursor, uint32_t *cp);

#ifdef __cplusplus
}
#endif
#endif
