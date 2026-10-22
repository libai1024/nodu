#include <stdio.h>
#include <stdlib.h>
#include "board.h"
#include "app.h"
#include "alarm.h"
#include "bsp_log.h"
#include "bsp_i2c.h"
#include "sht30.h"

/* C 要求先声明后使用：后面步骤新增的变量和函数都写在 app_init() / app_loop() 上方。 */

/* TODO(S15) 报警与恢复用到的常量和状态 */

/* TODO(S10) 周期采样：读取一次传感器并打印 */

/* TODO(S1) 应用骨架：app_init() 与 app_loop() */
