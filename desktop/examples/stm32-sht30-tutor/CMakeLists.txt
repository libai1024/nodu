# stm32-sht30-tutor: STM32 HAL 工程，由 Nodu 生成。可以直接修改。
# 新建的 .c 文件放进 Core/Src、Board 或 App，下次编译自动参与。
cmake_minimum_required(VERSION 3.24)
include(cmake/nodu-target.cmake)
project(stm32_sht30_tutor LANGUAGES C ASM)
include(cmake/nodu.cmake)

target_sources(firmware PRIVATE main.c Support/tutor_target.c Support/starter.c
  app/app.c app/alarm.c bsp/bsp_log.c bsp/bsp_i2c.c drivers/sht30.c drivers/sht30_calc.c)
target_include_directories(firmware PRIVATE app bsp drivers)
