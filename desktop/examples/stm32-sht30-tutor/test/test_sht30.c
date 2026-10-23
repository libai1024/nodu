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

/* TODO(S6) test_crc8()：用数据手册的测试向量检查 sht30_crc8() */

/* TODO(S9) test_convert()：检查 sht30_convert() 的换算 */

/* TODO(S13) test_alarm()：检查报警的进入、保持与退出 */

int main(void)
{
    /* 每写完一组测试，就在这里调用它。 */
    if (!checks) { puts("尚未执行任何测试"); return 2; }
    if (failures) {
        printf("%d 项失败\n", failures);
        return 1;
    }
    printf("全部通过\n");
    return 0;
}
