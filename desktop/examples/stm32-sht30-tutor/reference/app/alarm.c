#include "alarm.h"
bool alarm_update(alarm_t *alarm, float celsius)
{
    bool next = alarm->active ? celsius >= alarm->off_celsius : celsius >= alarm->on_celsius;
    bool changed = next != alarm->active;
    alarm->active = next;
    return changed;
}
