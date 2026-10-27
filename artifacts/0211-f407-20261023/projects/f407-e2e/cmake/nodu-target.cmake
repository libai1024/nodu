# 芯片：STM32F407ZGT6。由 Nodu 根据 nodu.json 生成；更换芯片请新建工程。
set(NODU_MCU STM32F407ZGTx)
set(NODU_SERIES STM32F4xx)
set(NODU_SDK_DIR cube-f4)
set(NODU_CHIP_DEFINE STM32F407xx)
set(NODU_CPU_FLAGS -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard)
set(NODU_LINKER_SCRIPT Linker/STM32F407ZGTx_FLASH.ld)
