/* Modified 2026-10-23: generic file and API names; original license retained. */
#include "types.h"
#if DEVICE_ENABLE_AS5600
/**
 * @file as5600.c
 * @author STM32 Study Studio contributors
 * @brief AS5600 有错误传播的只读接口，无动态内存，不修改 OTP。
 */
#include "as5600.h"
#include "i2c.h"
#include "delay.h"
#include <stdio.h>

#define AS5600_REG_ANGLE     0x0Eu
#define AS5600_REG_RAW_ANGLE 0x0Cu
#define AS5600_REG_STATUS    0x0Bu

static const i2c_dev_t as5600_dev = { I2C_1, AS5600_ADDR, 100 };
static uint8 as5600_status = AS5600_OK;

static uint8 as5600_read_12bit(uint8 reg, uint16 *angle)
{
    uint8 data[2];
    if (angle == NULL)
        return as5600_status = AS5600_ERR_ARGUMENT;
    if (i2c_dev_mem_read(&as5600_dev, reg, data, sizeof(data)) != 0)
        return as5600_status = AS5600_ERR_I2C;
    *angle = (uint16)((((uint16)data[0] << 8) | data[1]) & 0x0FFFu);
    return as5600_status = AS5600_OK;
}

uint8 as5600_init_checked(void)
{
    uint8 status;
    return as5600_read_status_checked(&status);
}
uint8 as5600_read_angle_checked(uint16 *angle)
{
    return as5600_read_12bit(AS5600_REG_ANGLE, angle);
}
uint8 as5600_read_raw_angle_checked(uint16 *angle)
{
    return as5600_read_12bit(AS5600_REG_RAW_ANGLE, angle);
}
uint8 as5600_read_status_checked(uint8 *status)
{
    uint8 value;
    if (status == NULL)
        return as5600_status = AS5600_ERR_ARGUMENT;
    if (i2c_dev_mem_read(&as5600_dev, AS5600_REG_STATUS, &value, 1) != 0)
        return as5600_status = AS5600_ERR_I2C;
    *status = value;
    return as5600_status = AS5600_OK;
}
uint8 as5600_angle_deg_checked(float *degrees)
{
    uint16 angle;
    if (degrees == NULL)
        return as5600_status = AS5600_ERR_ARGUMENT;
    if (as5600_read_angle_checked(&angle) != AS5600_OK)
        return as5600_status;
    *degrees = (float)angle * (360.0f / 4096.0f);
    return AS5600_OK;
}
uint8 as5600_is_magnet_checked(uint8 *detected)
{
    uint8 status;
    if (detected == NULL)
        return as5600_status = AS5600_ERR_ARGUMENT;
    if (as5600_read_status_checked(&status) != AS5600_OK)
        return as5600_status;
    *detected = (status & AS5600_STATUS_MD) ? 1u : 0u;
    return AS5600_OK;
}
uint8 as5600_last_status(void) { return as5600_status; }
void as5600_init(void) { (void)as5600_init_checked(); }
uint16 as5600_read_angle(void)
{
    uint16 angle = AS5600_INVALID_ANGLE;
    (void)as5600_read_angle_checked(&angle);
    return angle;
}
float as5600_angle_deg(void)
{
    float degrees = -1.0f;
    (void)as5600_angle_deg_checked(&degrees);
    return degrees;
}
uint8 as5600_is_magnet(void)
{
    uint8 detected = 0;
    (void)as5600_is_magnet_checked(&detected);
    return detected;
}
void as5600_test(void)
{
    i2c_init(I2C_1, 400000, I2C1_SCL_PB8_SDA_PB9);
    while (1)
    {
        float degrees;
        uint8 status;
        if (as5600_angle_deg_checked(&degrees) != AS5600_OK ||
            as5600_read_status_checked(&status) != AS5600_OK)
            printf("AS5600 I2C error\r\n");
        else
            printf("Angle: %.2f MD:%u ML:%u MH:%u\r\n", (double)degrees,
                   (unsigned)((status & AS5600_STATUS_MD) != 0),
                   (unsigned)((status & AS5600_STATUS_ML) != 0),
                   (unsigned)((status & AS5600_STATUS_MH) != 0));
        delay_wait_ms(200);
    }
}
#endif /* DEVICE_ENABLE_AS5600 */
