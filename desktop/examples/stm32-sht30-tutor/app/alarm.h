#ifndef ALARM_H
#define ALARM_H
#include <stdbool.h>

/* 带迟滞的高温报警：达到 on_celsius 进入报警，低于 off_celsius 才退出。 */
typedef struct {
    float on_celsius;
    float off_celsius;
    bool active;
} alarm_t;

/* 用新的温度更新报警状态；状态发生变化时返回 true。 */
bool alarm_update(alarm_t *alarm, float celsius);

#endif
