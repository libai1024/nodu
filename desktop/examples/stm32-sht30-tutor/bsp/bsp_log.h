#ifndef BSP_LOG_H
#define BSP_LOG_H

/* 通过日志串口输出一行文本（自动补换行）；成功返回 0，失败返回 -1。 */
int log_line(const char *text);

#endif
