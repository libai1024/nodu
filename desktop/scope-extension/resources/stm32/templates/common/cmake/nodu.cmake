# Nodu 的 STM32 HAL 构建规则。芯片参数见 nodu-target.cmake。
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
option(NODU_PRINTF_FLOAT "printf 支持 %f（程序增加约 10 KB）" OFF)

# SDK：导出的独立工程使用自带的 Drivers/；在 Nodu 中使用工具包里的只读 SDK。
if(EXISTS "${CMAKE_SOURCE_DIR}/Drivers/${NODU_SERIES}_HAL_Driver")
  set(NODU_SDK_ROOT "${CMAKE_SOURCE_DIR}")
elseif(DEFINED ENV{NODU_STM32_TOOLKIT})
  set(NODU_SDK_ROOT "$ENV{NODU_STM32_TOOLKIT}/sdk/${NODU_SDK_DIR}")
endif()
if(NOT EXISTS "${NODU_SDK_ROOT}/Drivers/${NODU_SERIES}_HAL_Driver")
  message(FATAL_ERROR "找不到 ${NODU_SERIES} HAL。请在 Nodu 中编译，或设置环境变量 NODU_STM32_TOOLKIT。")
endif()
string(TOLOWER "${NODU_SERIES}" NODU_SERIES_LOWER)
set(NODU_HAL "${NODU_SDK_ROOT}/Drivers/${NODU_SERIES}_HAL_Driver")
set(NODU_CMSIS "${NODU_SDK_ROOT}/Drivers/CMSIS")

# HAL 模块：按 hal_conf.h 中启用的 HAL_xxx_MODULE_ENABLED 选择源文件。
set(NODU_HAL_CONF "${CMAKE_SOURCE_DIR}/Core/Inc/${NODU_SERIES_LOWER}_hal_conf.h")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${NODU_HAL_CONF}")
file(STRINGS "${NODU_HAL_CONF}" NODU_ENABLED REGEX "^[ \t]*#define[ \t]+HAL_[A-Z0-9_]+_MODULE_ENABLED")
set(NODU_MODULES CORTEX RCC FLASH PWR GPIO)
foreach(LINE IN LISTS NODU_ENABLED)
  string(REGEX REPLACE "^[ \t]*#define[ \t]+HAL_([A-Z0-9_]+)_MODULE_ENABLED.*" "\\1" MODULE "${LINE}")
  list(APPEND NODU_MODULES ${MODULE})
endforeach()
# 外设模块依赖 DMA 的类型与函数。
foreach(MODULE ADC DAC I2C I2S SPI TIM UART USART IRDA SMARTCARD SD MMC SAI QSPI DCMI)
  if(MODULE IN_LIST NODU_MODULES)
    list(APPEND NODU_MODULES DMA)
  endif()
endforeach()
list(REMOVE_DUPLICATES NODU_MODULES)
set(NODU_HAL_SOURCES "${NODU_HAL}/Src/${NODU_SERIES_LOWER}_hal.c")
foreach(MODULE IN LISTS NODU_MODULES)
  string(TOLOWER "${MODULE}" NAME)
  foreach(SUFFIX "" "_ex")
    if(EXISTS "${NODU_HAL}/Src/${NODU_SERIES_LOWER}_hal_${NAME}${SUFFIX}.c")
      list(APPEND NODU_HAL_SOURCES "${NODU_HAL}/Src/${NODU_SERIES_LOWER}_hal_${NAME}${SUFFIX}.c")
    endif()
  endforeach()
endforeach()
# 存储与 USB 模块还需要对应的底层（LL）驱动。
foreach(PAIR "SRAM;fsmc" "NOR;fsmc" "NAND;fsmc" "PCCARD;fsmc" "SDRAM;fmc" "SRAM;fmc" "NOR;fmc" "NAND;fmc"
             "SD;sdmmc" "MMC;sdmmc" "PCD;usb" "HCD;usb")
  list(GET PAIR 0 MODULE)
  list(GET PAIR 1 LL)
  if(MODULE IN_LIST NODU_MODULES AND EXISTS "${NODU_HAL}/Src/${NODU_SERIES_LOWER}_ll_${LL}.c")
    list(APPEND NODU_HAL_SOURCES "${NODU_HAL}/Src/${NODU_SERIES_LOWER}_ll_${LL}.c")
  endif()
endforeach()
list(REMOVE_DUPLICATES NODU_HAL_SOURCES)

# 工程源文件：Core/Src、Board、App 下的 .c，Startup 下的 .s。
file(GLOB_RECURSE NODU_SOURCES CONFIGURE_DEPENDS
  "${CMAKE_SOURCE_DIR}/Core/Src/*.c" "${CMAKE_SOURCE_DIR}/Board/*.c" "${CMAKE_SOURCE_DIR}/App/*.c"
  "${CMAKE_SOURCE_DIR}/Startup/*.s")

set(NODU_COMMON_FLAGS ${NODU_CPU_FLAGS} -ffunction-sections -fdata-sections
  -fdiagnostics-plain-output -fdiagnostics-column-unit=byte)
set(NODU_INCLUDES "${CMAKE_SOURCE_DIR}/Core/Inc" "${CMAKE_SOURCE_DIR}/Board" "${CMAKE_SOURCE_DIR}/App")
set(NODU_SDK_INCLUDES "${NODU_HAL}/Inc" "${NODU_HAL}/Inc/Legacy"
  "${NODU_CMSIS}/Device/ST/${NODU_SERIES}/Include" "${NODU_CMSIS}/Include")
set(NODU_DEFINES USE_HAL_DRIVER ${NODU_CHIP_DEFINE})

# HAL 单独编译且不显示警告：SDK 内部的警告与学生代码无关。
add_library(nodu_hal OBJECT ${NODU_HAL_SOURCES})
target_include_directories(nodu_hal PRIVATE ${NODU_INCLUDES} ${NODU_SDK_INCLUDES})
target_compile_definitions(nodu_hal PRIVATE ${NODU_DEFINES})
target_compile_options(nodu_hal PRIVATE ${NODU_COMMON_FLAGS} -w $<IF:$<CONFIG:Release>,-Os,-Og> -g3)

add_executable(firmware ${NODU_SOURCES} $<TARGET_OBJECTS:nodu_hal>)
target_include_directories(firmware PRIVATE ${NODU_INCLUDES})
target_include_directories(firmware SYSTEM PRIVATE ${NODU_SDK_INCLUDES})
target_compile_definitions(firmware PRIVATE ${NODU_DEFINES})
target_compile_options(firmware PRIVATE ${NODU_COMMON_FLAGS} $<IF:$<CONFIG:Release>,-Os,-Og> -g3 -Wall -Wextra)
if(NODU_PRINTF_FLOAT)
  target_link_options(firmware PRIVATE -u _printf_float)
endif()
target_link_options(firmware PRIVATE ${NODU_CPU_FLAGS} -mthumb -nostartfiles
  --specs=nano.specs --specs=nosys.specs
  "-T${CMAKE_SOURCE_DIR}/${NODU_LINKER_SCRIPT}"
  -Wl,--gc-sections "-Wl,-Map=firmware.map" -Wl,--print-memory-usage)
set_target_properties(firmware PROPERTIES SUFFIX .elf LINK_DEPENDS "${CMAKE_SOURCE_DIR}/${NODU_LINKER_SCRIPT}")
add_custom_command(TARGET firmware POST_BUILD
  # MinGW objcopy interprets non-ASCII argv in the active Windows code page.
  # Keep filenames relative while CMake owns the Unicode working directory.
  COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE_NAME:firmware> firmware.bin
  COMMAND ${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE_NAME:firmware> firmware.hex
  WORKING_DIRECTORY "$<TARGET_FILE_DIR:firmware>"
  VERBATIM)
