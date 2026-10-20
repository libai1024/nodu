import time
from fpioa_manager import fm
from Maix import GPIO

fm.register(16, fm.fpioa.GPIOHS2, force=True)
key = GPIO(GPIO.GPIOHS2, GPIO.IN, GPIO.PULL_UP)
presses = 0

def on_key(pin):
    global presses
    presses += 1

key.irq(on_key, GPIO.IRQ_FALLING, GPIO.WAKEUP_NOT_SUPPORT, 7)
print("NODU_KEY_ARMED")
try:
    for step in range(10):
        print("NODU_KEY value=%d interrupts=%d" % (key.value(), presses))
        time.sleep_ms(500)
finally:
    key.disirq()
    fm.unregister(16)
print("NODU_KEY_DONE")
