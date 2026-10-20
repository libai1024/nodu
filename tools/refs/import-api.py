#!/usr/bin/env python3
"""Extract API names from explicitly selected, pinned MaixPy C dictionaries.

This is a source index, not a claim that every conditional export is enabled
in a particular firmware. It does not infer function signatures or copy docs.
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT.parent / "nodu-refs/MaixPy-v1"
REVISION = "d8901fd2272f000226f1c1037c1eb7c412b88e66"
PREFIX = "components/micropython/port/src/"
TABLES = [
    ("sensor", "omv/py/py_sensor.c", "globals_dict_table"),
    ("image", "omv/py/py_image.c", "globals_dict_table"),
    ("image.Image", "omv/py/py_image.c", "locals_dict_table"),
    ("lcd", "omv/py/py_lcd.c", "globals_dict_table"),
    ("machine", "standard_lib/machine/modmachine.c", "machine_module_globals_table"),
    ("machine.UART", "standard_lib/machine/machine_uart.c", "machine_uart_locals_dict_table"),
    ("machine.Timer", "standard_lib/machine/machine_timer.c", "machine_timer_locals_dict_table"),
    ("machine.PWM", "standard_lib/machine/machine_pwm.c", "k210_pwm_locals_dict_table"),
    ("machine.I2C", "standard_lib/machine/machine_i2c.c", "machine_i2c_locals_dict_table"),
    ("machine.SPI", "standard_lib/machine/machine_spi.c", "machine_spi_locals_dict_table"),
    ("Maix", "Maix/modMaix.c", "maix_module_globals_table"),
    ("Maix.GPIO", "Maix/Maix_gpio.c", "Maix_gpio_locals_dict_table"),
    ("Maix.FPIOA", "Maix/Maix_fpioa.c", "Maix_fpioa_locals_dict_table"),
    ("Maix.I2S", "Maix/Maix_i2s.c", "Maix_i2s_locals_dict_table"),
    ("KPU", "Maix/Maix_kpu.c", "globals_dict_table"),
]
ENTRY = re.compile(
    r"\{\s*(?:MP_ROM_QSTR|MP_OBJ_NEW_QSTR)\(MP_QSTR_(\w+)\)\s*,\s*([^\n}]*)\}"
)


def main():
    groups = {}
    for namespace, relative, table in TABLES:
        path = PREFIX + relative
        source = subprocess.check_output(
            ["git", "-C", str(SOURCE), "show", f"{REVISION}:{path}"],
            text=True,
        )
        table_pattern = rf"\b{re.escape(table)}\[\]\s*=\s*\{{(.*?)\n\}};"
        matches = list(re.finditer(table_pattern, source, re.S))
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one {path}:{table}")
        match = matches[0]
        # These selected dictionary initializers contain QSTR names and C
        # pointers/integers. Comments must not introduce disabled API entries.
        body = re.sub(
            r"/\*.*?\*/|//[^\n]*",
            lambda comment: "\n" * comment[0].count("\n"),
            match[1],
            flags=re.S,
        )
        entries = {}
        for entry in ENTRY.finditer(body):
            name, value = entry.groups()
            if name == "__name__":
                continue
            kind = "callable" if "&" in value else "constant"
            line = source[:match.start(1)].count("\n") + body[:entry.start()].count("\n") + 1
            # Several pinned dictionaries contain identical duplicate entries.
            prior = entries.get(name)
            if prior and prior["kind"] != kind:
                raise ValueError(f"Conflicting API entries: {namespace}.{name}")
            entries.setdefault(name, {"name": name, "kind": kind, "line": line})
        if not entries:
            raise ValueError(f"No exported names extracted from {path}:{table}")
        groups[namespace] = {"source": path, "entries": list(entries.values())}

    # Independent anchors from inspected source: commented-out entries must
    # remain absent, and module/instance dictionaries must stay separate.
    names = lambda group: {entry["name"] for entry in groups[group]["entries"]}
    assert {"reset", "snapshot", "RGB565", "QVGA"} <= names("sensor")
    assert "alloc_extra_fb" not in names("sensor")
    assert {"Image", "ImageReader", "ImageWriter"} <= names("image")
    assert "find_blobs" in names("image.Image")
    assert "find_blobs" not in names("image")
    assert {"UART", "Timer", "PWM"} <= names("machine")
    assert {"init", "deinit"} <= names("machine.UART")
    assert {"load", "forward", "deinit"} <= names("KPU")
    assert {"GPIO", "FPIOA", "I2S"} <= names("Maix")

    output = {
        "repository": "sipeed/MaixPy-v1",
        "revision": REVISION,
        "conditionalExports": True,
        "signaturesInferred": False,
        "groups": groups,
    }
    destination = ROOT / "desktop/scope-extension/resources/api-index.json"
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(f"API dictionaries extracted from {REVISION}; source anchors passed.")


if __name__ == "__main__":
    main()
