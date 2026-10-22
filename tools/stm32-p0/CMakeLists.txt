cmake_minimum_required(VERSION 3.24)
project(nodu_stm32_p0 LANGUAGES C ASM)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_C_STANDARD 11)
if(NODU_TARGET STREQUAL "f103c8")
  set(FAMILY f1)
  set(SERIES STM32F1xx)
  set(CHIP STM32F103xB)
  set(STARTUP startup_stm32f103xb.s)
  set(CPU_FLAGS -mcpu=cortex-m3 -mfloat-abi=soft)
  set(TARGET_NUMBER 0x0103c8)
elseif(NODU_TARGET STREQUAL "f407zg")
  set(FAMILY f4)
  set(SERIES STM32F4xx)
  set(CHIP STM32F407xx)
  set(STARTUP startup_stm32f407xx.s)
  set(CPU_FLAGS -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard)
  set(TARGET_NUMBER 0x0407a1)
else()
  message(FATAL_ERROR "NODU_TARGET must be f103c8 or f407zg")
endif()
string(TOLOWER ${SERIES} SERIES_LOWER)
set(HAL "${SDK_ROOT}/Drivers/${SERIES}_HAL_Driver")
set(DEVICE "${SDK_ROOT}/Drivers/CMSIS/Device/ST/${SERIES}")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/config")
file(READ "${HAL}/Inc/${SERIES_LOWER}_hal_conf_template.h" HAL_CONF)
# Preserve the official template and its license, enable only this experiment's modules.
string(REGEX REPLACE "\n#define HAL_[A-Z0-9_]+_MODULE_ENABLED[^\n]*" "" HAL_CONF "${HAL_CONF}")
foreach(MODULE CORTEX RCC FLASH PWR GPIO)
  string(REPLACE "#define HAL_MODULE_ENABLED" "#define HAL_${MODULE}_MODULE_ENABLED\n#define HAL_MODULE_ENABLED" HAL_CONF "${HAL_CONF}")
endforeach()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/config/${SERIES_LOWER}_hal_conf.h" "${HAL_CONF}")
set(HAL_SOURCES)
foreach(MODULE hal hal_cortex hal_rcc hal_rcc_ex hal_flash hal_flash_ex hal_pwr hal_gpio)
  list(APPEND HAL_SOURCES "${HAL}/Src/${SERIES_LOWER}_${MODULE}.c")
endforeach()
if(FAMILY STREQUAL "f4")
  list(APPEND HAL_SOURCES "${HAL}/Src/${SERIES_LOWER}_hal_pwr_ex.c")
endif()
add_executable(firmware
  src/main.c src/interrupts.c src/runtime.c ${HAL_SOURCES}
  "${DEVICE}/Source/Templates/system_${SERIES_LOWER}.c"
  "${DEVICE}/Source/Templates/gcc/${STARTUP}")
target_include_directories(firmware PRIVATE
  "${CMAKE_CURRENT_BINARY_DIR}/config" "${HAL}/Inc" "${HAL}/Inc/Legacy"
  "${DEVICE}/Include" "${SDK_ROOT}/Drivers/CMSIS/Include")
target_compile_definitions(firmware PRIVATE USE_HAL_DRIVER ${CHIP} NODU_TARGET_NUMBER=${TARGET_NUMBER})
target_compile_options(firmware PRIVATE ${CPU_FLAGS} -Og -g3 -Wall -Wextra -ffunction-sections -fdata-sections)
target_link_options(firmware PRIVATE ${CPU_FLAGS} -mthumb -nostartfiles
  --specs=nano.specs --specs=nosys.specs
  "-T${CMAKE_CURRENT_SOURCE_DIR}/linker/${NODU_TARGET}.ld"
  "-L${CMAKE_CURRENT_SOURCE_DIR}/linker"
  -Wl,--gc-sections "-Wl,-Map=${CMAKE_CURRENT_BINARY_DIR}/firmware.map"
  -Wl,--print-memory-usage)
set_target_properties(firmware PROPERTIES SUFFIX .elf)
add_custom_command(TARGET firmware POST_BUILD
  COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:firmware> "${CMAKE_CURRENT_BINARY_DIR}/firmware.bin"
  COMMAND ${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:firmware> "${CMAKE_CURRENT_BINARY_DIR}/firmware.hex"
  COMMAND ${CMAKE_SIZE} $<TARGET_FILE:firmware>)
