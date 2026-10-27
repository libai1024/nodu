/* Modified 2026-10-23: generic file and API names; original license retained. */
#include "types.h"
#if DEVICE_ENABLE_OLED
/**
 * @file ssd1306.c
 * @author STM32 Study Studio contributors
 * @brief SSD1306 分页显示；绘图仅改本地 1024 字节显存。
 */
#include "ssd1306.h"
#include "i2c.h"
#include "font.h"
#include "font16.h"
#include <string.h>

#define OLED_CTRL_CMD  0x00u
#define OLED_CTRL_DATA 0x40u

static uint8 oled_buffer[OLED_PAGES][OLED_WIDTH];
static const i2c_dev_t oled_dev = { I2C_1, OLED_ADDR, 100 };
static uint8 oled_status = OLED_OK;

/* 原 6x8 表在 z 后只有一个占位项；这四项补全可打印 ASCII。 */
static const uint8 oled_ascii_tail_6x8[4][6] = {
    {0x00, 0x08, 0x36, 0x41, 0x41, 0x00}, /* { */
    {0x00, 0x00, 0x7F, 0x00, 0x00, 0x00}, /* | */
    {0x00, 0x41, 0x41, 0x36, 0x08, 0x00}, /* } */
    {0x08, 0x04, 0x08, 0x10, 0x08, 0x00}  /* ~ */
};

static uint8 oled_write_cmd(uint8 cmd)
{
    return i2c_dev_mem_write(&oled_dev, OLED_CTRL_CMD, &cmd, 1) != 0
        ? OLED_ERR_I2C : OLED_OK;
}

static uint8 oled_font_info(oled_font_enum font, uint8 *w, uint8 *h)
{
    if (font == OLED_FONT_6X8) { *w = 6; *h = 8; return 1; }
    if (font == OLED_FONT_8X16) { *w = 8; *h = 16; return 1; }
    return 0;
}

uint8 oled_init_checked(void)
{
    /* 20 02 选择 page addressing，与 refresh 的 B0..B7/列地址一致。
     * 先保持显示关闭，清空 GDDRAM 后再开屏，避免随机上电图像。
     */
    static const uint8 commands[] = {
        0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40,
        0x8D, 0x14, 0x20, 0x02, 0xA1, 0xC8, 0xDA, 0x12,
        0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x20, 0xA4, 0xA6, 0x2E
    };
    uint8 i;
    for (i = 0; i < sizeof(commands); ++i)
    {
        if (oled_write_cmd(commands[i]) != OLED_OK)
            return oled_status = OLED_ERR_I2C;
    }
    oled_clear();
    if (oled_refresh_checked() != OLED_OK)
        return oled_status;
    return oled_status = oled_write_cmd(0xAF);
}

uint8 oled_refresh_checked(void)
{
    uint8 page;
    for (page = 0; page < OLED_PAGES; ++page)
    {
        if (oled_write_cmd((uint8)(0xB0u + page)) != OLED_OK ||
            oled_write_cmd(0x00) != OLED_OK ||
            oled_write_cmd(0x10) != OLED_OK ||
            i2c_dev_mem_write(&oled_dev, OLED_CTRL_DATA,
                              oled_buffer[page], OLED_WIDTH) != 0)
            return oled_status = OLED_ERR_I2C;
    }
    return oled_status = OLED_OK;
}

uint8 oled_last_status(void) { return oled_status; }
void oled_init(void) { (void)oled_init_checked(); }
void oled_refresh(void) { (void)oled_refresh_checked(); }
void oled_clear(void) { memset(oled_buffer, 0, sizeof(oled_buffer)); }

void oled_show_char(uint8 x, uint8 y, char ch, oled_font_enum font)
{
    uint8 w, h, i, page, character = (uint8)ch;
    const uint8 *bitmap;
    if (!oled_font_info(font, &w, &h) || y % 8u != 0 ||
        x > OLED_WIDTH - w || y > OLED_HEIGHT - h)
        return;
    if (character < 32u || character > 126u) character = '?';
    page = y / 8u;
    if (font == OLED_FONT_6X8)
        bitmap = character > 'z' ? oled_ascii_tail_6x8[character - '{']
                                : ascii_font_6x8[character - 32u];
    else
        bitmap = ascii_font_8x16[character - 32u];
    for (i = 0; i < w; ++i)
    {
        oled_buffer[page][x + i] = bitmap[i];
        if (h == 16) oled_buffer[page + 1][x + i] = bitmap[i + w];
    }
}

void oled_show_string(uint8 x, uint8 y, const char *str, oled_font_enum font)
{
    uint8 w, h;
    uint16 col = x, row = y;
    if (str == NULL || !oled_font_info(font, &w, &h) ||
        x >= OLED_WIDTH || y > OLED_HEIGHT - h || y % 8u != 0)
        return;
    while (*str != '\0')
    {
        char ch = *str++;
        if (ch == '\r') continue;
        if (ch == '\n')
        {
            col = 0;
            row += h;
            if (row + h > OLED_HEIGHT) break;
            continue;
        }
        if (col + w > OLED_WIDTH) { col = 0; row += h; }
        if (row + h > OLED_HEIGHT) break;
        oled_show_char((uint8)col, (uint8)row, ch, font);
        col += w;
    }
}

void oled_show_num(uint8 x, uint8 y, uint32 num, uint8 len, oled_font_enum font)
{
    char text[11];
    uint8 i;
    if (len == 0) return;
    if (len > 10) len = 10;
    text[len] = '\0';
    for (i = len; i > 0; )
    {
        text[--i] = (char)('0' + num % 10u);
        num /= 10u;
    }
    oled_show_string(x, y, text, font);
}

void oled_show_float(uint8 x, uint8 y, float num, uint8 int_len,
                     uint8 dec_len, oled_font_enum font)
{
    char text[19]; /* sign + 10 digits + dot + 6 digits + NUL */
    uint8 i, pos = 0, int_start;
    uint32 integer;
    float magnitude, fraction;
    magnitude = num < 0.0f ? -num : num;
    if (!(magnitude < 4294967296.0f)) /* NaN/Inf 同样不满足比较 */
    {
        oled_show_string(x, y, "ERR", font);
        return;
    }
    if (int_len == 0) int_len = 1;
    if (int_len > 10) int_len = 10;
    if (dec_len > 6) dec_len = 6;
    integer = (uint32)magnitude;
    fraction = magnitude - (float)integer;
    if (num < 0.0f) text[pos++] = '-';
    int_start = pos;
    pos += int_len;
    for (i = pos; i > int_start; )
    {
        text[--i] = (char)('0' + integer % 10u);
        integer /= 10u;
    }
    if (dec_len != 0) text[pos++] = '.';
    for (i = 0; i < dec_len; ++i)
    {
        uint8 digit;
        fraction *= 10.0f;
        digit = (uint8)fraction;
        if (digit > 9) digit = 9;
        text[pos++] = (char)('0' + digit);
        fraction -= digit;
    }
    text[pos] = '\0';
    oled_show_string(x, y, text, font);
}

static void oled_missing_glyph(uint8 x, uint8 y)
{
    uint8 col, page = y / 8u;
    for (col = 0; col < 16; ++col)
    {
        oled_buffer[page][x + col] = (col == 0 || col == 15) ? 0xFF : 0x01;
        oled_buffer[page + 1][x + col] = (col == 0 || col == 15) ? 0xFF : 0x80;
    }
}

uint8 oled_show_codepoint(uint8 x, uint8 y, uint32 codepoint)
{
    uint8 col, page, width = codepoint >= 32u && codepoint <= 126u ? 8 : 16;
    const font16_glyph_t *glyph;
    if (codepoint > 0x10FFFFu || (codepoint >= 0xD800u && codepoint <= 0xDFFFu) ||
        y % 8u != 0 || x > OLED_WIDTH - width || y > OLED_HEIGHT - 16u)
        return OLED_ERR_ARGUMENT;
    if (width == 8)
    {
        oled_show_char(x, y, (char)codepoint, OLED_FONT_8X16);
        return OLED_OK;
    }
    glyph = font16_find(codepoint);
    if (glyph == NULL)
    {
        oled_missing_glyph(x, y);
        return OLED_ERR_GLYPH;
    }
    page = y / 8u;
    for (col = 0; col < 16; ++col)
    {
        oled_buffer[page][x + col] = glyph->bitmap[col];
        oled_buffer[page + 1][x + col] = glyph->bitmap[col + 16];
    }
    return OLED_OK;
}

uint8 oled_show_utf8(uint8 x, uint8 y, const char *text)
{
    uint16 col = x, row = y;
    uint8 result = OLED_OK;
    if (text == NULL || x >= OLED_WIDTH || y > OLED_HEIGHT - 16u || y % 8u != 0)
        return OLED_ERR_ARGUMENT;
    while (*text != '\0')
    {
        uint32 codepoint;
        uint8 width, status;
        int decoded = utf8_next(&text, &codepoint);
        if (decoded == 0) break;
        if (decoded > 0 && codepoint == '\r') continue;
        if (decoded > 0 && codepoint == '\n')
        {
            col = 0;
            row += 16;
            /* A trailing newline consumes no pixels and is accepted. */
            if (row + 16u > OLED_HEIGHT && *text != '\0')
                return result == OLED_OK ? OLED_ERR_CLIPPED : result;
            continue;
        }
        width = decoded > 0 && codepoint >= 32u && codepoint <= 126u ? 8 : 16;
        if (col + width > OLED_WIDTH) { col = 0; row += 16; }
        if (row + 16u > OLED_HEIGHT)
            return result == OLED_OK ? OLED_ERR_CLIPPED : result;
        if (decoded < 0)
        {
            oled_missing_glyph((uint8)col, (uint8)row);
            status = OLED_ERR_UTF8;
        }
        else
            status = oled_show_codepoint((uint8)col, (uint8)row, codepoint);
        if (result == OLED_OK) result = status;
        col += width;
    }
    return result;
}

void oled_draw_point(uint8 x, uint8 y, uint8 mode)
{
    if (x >= OLED_WIDTH || y >= OLED_HEIGHT) return;
    if (mode) oled_buffer[y / 8u][x] |= (uint8)(1u << (y % 8u));
    else oled_buffer[y / 8u][x] &= (uint8)~(1u << (y % 8u));
}

void oled_test(void)
{
    i2c_init(I2C_1, 400000, I2C1_SCL_PB8_SDA_PB9);
    if (oled_init_checked() != OLED_OK) return;
    (void)oled_show_utf8(0, 0, "温度:25C\n湿度:55%\n水位:正常\n角度:90");
    (void)oled_refresh_checked();
}
#endif /* DEVICE_ENABLE_OLED */
