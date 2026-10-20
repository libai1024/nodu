import time
from fpioa_manager import fm
from Maix import GPIO

PERIOD_MS = 500
fm.register(17, fm.fpioa.GPIOHS1, force=True)
led = GPIO(GPIO.GPIOHS1, GPIO.OUT)
started = time.ticks_ms()
try:
    for step in range(8):
        value = step % 2
        led.value(value)
        print("NODU_LED step=%d value=%d elapsed_ms=%d period_ms=%d" % (
            step, led.value(), time.ticks_diff(time.ticks_ms(), started), PERIOD_MS
        ))
        time.sleep_ms(PERIOD_MS)
finally:
    led.value(1)
    fm.unregister(17)
print("NODU_LED_DONE")
