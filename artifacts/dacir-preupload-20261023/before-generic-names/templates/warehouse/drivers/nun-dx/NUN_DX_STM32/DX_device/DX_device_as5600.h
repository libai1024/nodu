/**
 * @file DX_device_as5600.h
 * @brief AS5600 12 位磁编码器；I2C 总线由应用层初始化。
 * @author YCZ; STM32 Study Studio contributors
 */
#ifndef __DX_DEVICE_AS5600_H
#define __DX_DEVICE_AS5600_H
#include "DX_common_typedef.h"
#if DX_USE_AS5600
#ifdef __cplusplus
extern "C" {
#endif

#define AS5600_ADDR          0x36u  /* 7 位地址 */
#define AS5600_STATUS_MD     0x20u  /* bit5：检测到磁铁；不等于磁场强度合格 */
#define AS5600_STATUS_ML     0x10u  /* bit4：磁场过弱 */
#define AS5600_STATUS_MH     0x08u  /* bit3：磁场过强 */
#define AS5600_INVALID_ANGLE 0xFFFFu

typedef enum
{
    AS5600_OK = 0,
    AS5600_ERR_I2C = 1,
    AS5600_ERR_ARGUMENT = 2
} as5600_status_enum;

/* checked 接口返回状态码；失败时不修改输出参数，NULL 返回 ERR_ARGUMENT。
 * init 只读取 STATUS 检查通信，不更改配置，不写 OTP。
 * 不带 raw 的 angle 对应 ANGLE (0x0E)，raw 对应 RAW ANGLE (0x0C)。
 * 两者成功均为 0..4095；角度值还应配合 MD/ML/MH 判断传感器状态。
 */
uint8 as5600_init_checked           (void);
uint8 as5600_read_angle_checked     (uint16 *angle);
uint8 as5600_read_raw_angle_checked (uint16 *angle);
uint8 as5600_read_status_checked    (uint8 *status);
uint8 as5600_angle_deg_checked      (float *degrees);
uint8 as5600_is_magnet_checked      (uint8 *detected);
uint8 as5600_last_status            (void);

/* 旧 API 保持源兼容；必须检查 last_status 才能区分通信失败与无磁铁。
 * read_angle 失败返回 0xFFFF；angle_deg 失败返回 -1.0f；is_magnet 失败返回 0。
 */
void   as5600_init       (void);
uint16 as5600_read_angle (void);
float  as5600_angle_deg  (void);
uint8  as5600_is_magnet  (void);
void   as5600_test       (void);

#ifdef __cplusplus
}
#endif
#endif /* DX_USE_AS5600 */
#endif /* __DX_DEVICE_AS5600_H */
