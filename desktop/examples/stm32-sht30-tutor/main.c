/* 程序入口。时钟、引脚复用和外设实例由板卡包生成（board.c），这里只调用应用层。 */
#include "board.h"
#include "app.h"

int main(void)
{
    board_init();
    app_init();
    for (;;) {
        app_loop();
    }
}
