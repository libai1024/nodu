/* HAL_Init 调用 HAL_MspInit 做芯片级初始化。外设的引脚与时钟在各自的 HAL_xxx_MspInit 中配置。 */
#include "main.h"

void HAL_MspInit(void)
{
    __HAL_RCC_AFIO_CLK_ENABLE();
    __HAL_RCC_PWR_CLK_ENABLE();
    /* 关闭 JTAG、保留 SWD（PA13、PA14），PA15、PB3、PB4 可作普通引脚使用。 */
    __HAL_AFIO_REMAP_SWJ_NOJTAG();
}
