/* Modified 2026-10-23: generic file and API names; original license retained. */
/**
 * @file ssd1306.h
 * @brief SSD1306 128x64 OLED：分页显存、I2C 错误返回、UTF-8 中文。
 * @author STM32 Study Studio contributors
 */
#ifndef EMBEDDED_DEVICES_SSD1306_H
#define EMBEDDED_DEVICES_SSD1306_H
#include "types.h"
#if DEVICE_ENABLE_OLED
#ifdef __cplusplus
extern "C" {
#endif

#define OLED_ADDR   0x3Cu
#define OLED_WIDTH  128u
#define OLED_HEIGHT 64u
#define OLED_PAGES  (OLED_HEIGHT / 8u)

typedef enum
{
    OLED_FONT_6X8,
    OLED_FONT_8X16
} oled_font_enum;

typedef enum
{
    OLED_OK = 0,
    OLED_ERR_I2C = 1,
    OLED_ERR_ARGUMENT = 2,
    OLED_ERR_GLYPH = 3,
    OLED_ERR_UTF8 = 4,
    OLED_ERR_CLIPPED = 5
} oled_status_enum;

/* 应用层先调用 i2c_init。失败立即停止本次传输，可在总线恢复后重试。
 * last_status 仅记录最近 init/refresh 的结果，绘图不会覆盖通信错误。
 * I2C ACK 只能验证通信，不能检测实际发光、接线方向或面板损坏。
 */
uint8 oled_init_checked    (void);
uint8 oled_refresh_checked (void);
uint8 oled_last_status     (void);
void  oled_init            (void); /* 旧 API 包装，结果用 last_status 读取 */
void  oled_refresh         (void);
void  oled_clear           (void); /* 以下绘图只修改内存，需 refresh */

/* 字符坐标 y 必须按 8 像素对齐；无效坐标/font 不绘制。
 * ASCII 范围 32..126，其余字节显示 '?'；字符串支持 \n、忽略 \r。
 */
void oled_show_char   (uint8 x, uint8 y, char ch, oled_font_enum font);
void oled_show_string (uint8 x, uint8 y, const char *str, oled_font_enum font);
/* num 按原行为前补零、截高位；len=0 不绘制，len>10 按10处理。 */
void oled_show_num    (uint8 x, uint8 y, uint32 num, uint8 len, oled_font_enum font);
/* 保留符号；整数位限定1..10、小数位限定0..6；小数截断。
 * NaN/Inf 或绝对值>=2^32 显示 ERR，避免未定义的浮点转整数行为。
 */
void oled_show_float  (uint8 x, uint8 y, float num, uint8 int_len, uint8 dec_len, oled_font_enum font);

/* UTF-8：可打印 ASCII 为8x16，字库字形为16x16；y按8对齐，行高16。
 * codepoint 不自动换行；边界无效返回 ARGUMENT，且不修改显存。
 * utf8 自动换行，\n 换行、\r 忽略；参数/初始坐标错误立即返回。
 * 缺字画16x16方框并返回 GLYPH；非法编码画方框并返回 UTF8。
 * 缺字/非法编码继续显示后续文字；屏满停止，返回第一个错误。
 * 单字快速查表见 font16.h 的 font16_find(0x6E29)。
 */
uint8 oled_show_codepoint(uint8 x, uint8 y, uint32 codepoint);
uint8 oled_show_utf8     (uint8 x, uint8 y, const char *text);
void oled_draw_point    (uint8 x, uint8 y, uint8 mode);
void oled_test          (void);

#ifdef __cplusplus
}
#endif
#endif /* DEVICE_ENABLE_OLED */
#endif /* EMBEDDED_DEVICES_SSD1306_H */
