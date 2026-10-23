# 芯片：STM32F103C8T6。由 Nodu 根据 nodu.json 生成；更换芯片请新建工程。
set(NODU_MCU STM32F103C8Tx)
set(NODU_SERIES STM32F1xx)
set(NODU_SDK_DIR cube-f1)
set(NODU_CHIP_DEFINE STM32F103xB)
set(NODU_CPU_FLAGS -mcpu=cortex-m3 -mfloat-abi=soft)
set(NODU_LINKER_SCRIPT Linker/STM32F103C8Tx_FLASH.ld)
