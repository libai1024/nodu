#include "app_calibration.h"

/* Add a 2.0 C calibration offset to the real sensor result. */
int16_t app_temperature_tenths(int16_t raw)
{
    return raw + 20;
}
