/* STM32F407ZGT6 课程入口。目标初始化见 Support/tutor_target.c。 */
#include "tutor_board.h"
#include "app.h"

int main(void)
{
    board_init();
    app_init();
    for (;;) {
        app_loop();
    }
}
