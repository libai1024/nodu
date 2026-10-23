/* 电脑上运行的单元测试：只编译纯函数文件，不需要 HAL 和开发板。
 *   cc -std=c99 -Wall -Idrivers -Iapp test/test_sht30.c drivers/sht30_calc.c app/alarm.c -o test_sht30 && ./test_sht30
 */
#include <stdio.h>
#include "sht30.h"
#include "alarm.h"

static int failures;
static int checks;
#define CHECK(cond) do { checks++; if (!(cond)) { printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)
/* 浮点数不能用 == 比较：误差在 0.01 以内视为相等。 */
#define NEAR(a, b) ((a) - (b) < 0.01f && (b) - (a) < 0.01f)

static void test_crc8(void)
{
    const uint8_t sample[2] = { 0xBE, 0xEF };  /* 数据手册示例 */
    CHECK(sht30_crc8(sample, 2) == 0x92);
    const uint8_t zero[2] = { 0x00, 0x00 };
    CHECK(sht30_crc8(zero, 2) == 0x81);
}
/* 并在 main() 开头调用 test_crc8(); */


static void test_convert(void)
{
    sht30_reading_t r = sht30_convert((sht30_raw_t){ 0x6666, 0x8000 });
    CHECK(NEAR(r.celsius, 25.0f));
    CHECK(NEAR(r.percent_rh, 50.0f));
    r = sht30_convert((sht30_raw_t){ 0x0000, 0xFFFF });
    CHECK(NEAR(r.celsius, -45.0f));
    CHECK(NEAR(r.percent_rh, 100.0f));
}
/* 并在 main() 中调用 test_convert(); */


static void test_alarm(void)
{
    alarm_t a = { 30.0f, 28.0f, false };
    CHECK(!alarm_update(&a, 29.0f) && !a.active);  /* 未达到上限 */
    CHECK(alarm_update(&a, 30.0f) && a.active);    /* 进入 */
    CHECK(!alarm_update(&a, 29.0f) && a.active);   /* 迟滞区内保持 */
    CHECK(alarm_update(&a, 27.9f) && !a.active);   /* 退出 */
}
/* 并在 main() 中调用 test_alarm(); */


int main(void)
{
    test_crc8();
    test_convert();
    test_alarm();
    if (!checks) { puts("尚未执行任何测试"); return 2; }
    if (failures) {
        printf("%d 项失败\n", failures);
        return 1;
    }
    printf("全部通过\n");
    return 0;
}
