#ifndef APP_H
#define APP_H

/* 上电后调用一次：初始化各模块。 */
void app_init(void);
/* 主循环每次调用：不能长时间阻塞。 */
void app_loop(void);

#endif
