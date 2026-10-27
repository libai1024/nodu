# SPDX-License-Identifier: MIT
# Nodu adapter for the DACIR directory build recipe. Uses the generic library layout.
cmake_minimum_required(VERSION 3.24)
project(dacir_firmware LANGUAGES C ASM)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_C_STANDARD 11)
if(NOT DEFINED NODU_SDK_ROOT AND DEFINED ENV{NODU_STM32_TOOLKIT})
  set(NODU_SDK_ROOT "$ENV{NODU_STM32_TOOLKIT}/sdk/cube-f1")
endif()
set(HAL "${NODU_SDK_ROOT}/Drivers/STM32F1xx_HAL_Driver")
set(CMSIS "${NODU_SDK_ROOT}/Drivers/CMSIS")
set(DEVICE "${CMSIS}/Device/ST/STM32F1xx")
if(NOT EXISTS "${HAL}/Src/stm32f1xx_hal.c")
  message(FATAL_ERROR "STM32 SDK unavailable. Build in Nodu or set NODU_STM32_TOOLKIT.")
endif()
set(EMBEDDED "${CMAKE_CURRENT_SOURCE_DIR}/drivers/embedded")
file(GLOB_RECURSE APP CONFIGURE_DEPENDS "src/*.c" "src/*.s" "src/*.S")
file(GLOB DRIVERS CONFIGURE_DEPENDS "${EMBEDDED}/peripherals/*.c" "${EMBEDDED}/devices/*.c")
set(SOURCES ${APP} ${DRIVERS})
foreach(NAME font font16 fifo interrupts)
  list(APPEND SOURCES "${EMBEDDED}/common/${NAME}.c")
endforeach()
list(APPEND SOURCES "nodu-support/runtime.c" "nodu-support/hal_timebase.c"
  "${DEVICE}/Source/Templates/system_stm32f1xx.c")
foreach(NAME hal hal_cortex hal_rcc hal_rcc_ex hal_gpio hal_dma hal_flash hal_flash_ex hal_i2c hal_pwr hal_tim hal_tim_ex hal_adc hal_adc_ex hal_spi hal_uart hal_exti)
  list(APPEND SOURCES "${HAL}/Src/stm32f1xx_${NAME}.c")
endforeach()
# Keep startup weak aliases after the application's weak timebase implementation.
list(APPEND SOURCES "${DEVICE}/Source/Templates/gcc/startup_stm32f103xb.s")
add_executable(firmware ${SOURCES})
set_target_properties(firmware PROPERTIES SUFFIX ".elf")
file(GLOB_RECURSE HEADERS CONFIGURE_DEPENDS "src/*.h" "include/*.h" "drivers/*.h")
set(INCLUDES "${CMAKE_CURRENT_SOURCE_DIR}/nodu-support" "${HAL}/Inc" "${DEVICE}/Include" "${CMSIS}/Include")
foreach(HEADER IN LISTS HEADERS)
  get_filename_component(DIR "${HEADER}" DIRECTORY)
  list(APPEND INCLUDES "${DIR}")
endforeach()
list(REMOVE_DUPLICATES INCLUDES)
target_include_directories(firmware PRIVATE ${INCLUDES})
target_compile_definitions(firmware PRIVATE STM32F103xB USE_HAL_DRIVER)
# This freestanding runtime has no newlib printf float switch.
target_compile_options(firmware PRIVATE -mcpu=cortex-m3 -mthumb -mfloat-abi=soft -Os -g3
  -ffreestanding -fno-common -ffunction-sections -fdata-sections -Wall -Wextra
  -Werror=implicit-function-declaration -fdiagnostics-plain-output -fdiagnostics-column-unit=byte
  -include "${CMAKE_CURRENT_SOURCE_DIR}/include/config.h")
target_link_options(firmware PRIVATE -mcpu=cortex-m3 -mthumb -mfloat-abi=soft -nostdlib
  "-T${CMAKE_CURRENT_SOURCE_DIR}/nodu-support/stm32f103c8.ld"
  "-Wl,--gc-sections,-Map,${CMAKE_CURRENT_BINARY_DIR}/firmware.map")
set_property(TARGET firmware APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/nodu-support/stm32f103c8.ld")
target_link_libraries(firmware PRIVATE gcc)
add_custom_command(TARGET firmware POST_BUILD
  COMMAND "${CMAKE_OBJCOPY}" -O binary "$<TARGET_FILE:firmware>" "${CMAKE_CURRENT_BINARY_DIR}/firmware.bin"
  COMMAND "${CMAKE_OBJCOPY}" -O ihex "$<TARGET_FILE:firmware>" "${CMAKE_CURRENT_BINARY_DIR}/firmware.hex"
  VERBATIM)
