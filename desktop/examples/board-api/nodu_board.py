# SPDX-License-Identifier: MIT
"""Read-only board declaration helper for MaixPy (K210).

Reads the board-side /flash/config.json declaration through Maix.config and
exposes logical pin names. This module never writes the config, never resets
the board, never calls fm.register, and applies no default pin fallback:
unknown names raise ValueError.

Copy this file to the board (e.g. /flash/nodu_board.py) with the app's file
manager; nothing is installed automatically.

    import nodu_board
    nodu_board.info()          # {'type': ..., 'config_name': ..., ...}
    nodu_board.pins()          # {'USER_LED': 17, 'BOOT_KEY': 16, ...}
    nodu_board.pin('LED')      # USER_LED, falling back to LED_R
    nodu_board.pin('BUTTON')   # BOOT_KEY
    nodu_board.peripheral('sensor')  # declared sensor section (a copy)

Returned IO numbers are physical chip IO indices (0-47), not GPIO/GPIOHS
channel numbers. The declaration does not guarantee polarity or that a driver
is loaded; GPIO use still needs explicit Maix GPIO/fm calls in your own code.
"""
from Maix import config as _config

_IO_MIN = 0
_IO_MAX = 47
_D_MAX = 48
_PERIPHERALS = ('sensor', 'lcd', 'sdcard')
# Friendly names resolve through these candidates before the literal name.
_ALIASES = {
    'LED': ('USER_LED', 'LED_R'),
    'BUTTON': ('BOOT_KEY',),
}
_FORBIDDEN = ('__proto__', 'constructor', 'prototype')


def _board_info():
    info = _config.get_value('board_info', None)
    return info if isinstance(info, dict) else {}


def _io(name, value):
    if isinstance(value, bool) or not isinstance(value, int) \
            or not _IO_MIN <= value <= _IO_MAX:
        raise ValueError('%s is not a physical IO (integer %d-%d): %r'
                         % (name, _IO_MIN, _IO_MAX, value))
    return value


def _valid_name(name):
    # Plain character checks: MicroPython's ure has no {m,n} quantifier
    # support, so no regex is used here.
    if not isinstance(name, str) or not 1 <= len(name) <= 64:
        return False
    first = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_'
    rest = first + '0123456789'
    return name[0] in first and all(c in rest for c in name) \
        and name not in _FORBIDDEN


def _copy(value):
    """Recursive copy of the JSON-shaped values Maix.config returns."""
    if isinstance(value, dict):
        return {key: _copy(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_copy(item) for item in value]
    return value


def info():
    """Return the declared identifiers and where they were read from."""
    return {
        'type': _config.get_value('type', None),
        'config_name': _config.get_value('config_name', None),
        'source': '/flash/config.json',
        'read_via': 'Maix.config runtime cache',
        'declaration': 'the runtime cache backs onto /flash/config.json; '
                       'file edits only take effect after reboot',
    }


def pins():
    """Return a copy of the declared logical pin table (alias -> chip IO)."""
    result = {}

    def set_pin(name, io):
        if name in result and result[name] != io:
            raise ValueError('pin %r is declared with conflicting IOs' % name)
        result[name] = io

    for name, value in _board_info().items():
        if name == 'pin_num':
            if isinstance(value, bool) or not isinstance(value, int) \
                    or not 0 <= value <= _D_MAX:
                raise ValueError('pin_num must be an integer 0-%d: %r'
                                 % (_D_MAX, value))
            continue
        if name == 'pin_name':
            if not isinstance(value, (list, tuple)) \
                    or not all(isinstance(item, str) for item in value):
                raise ValueError('pin_name must be a list of strings')
            continue
        if name == 'D':
            if not isinstance(value, (list, tuple)) or len(value) > _D_MAX:
                raise ValueError('D must be a list of at most %d IOs' % _D_MAX)
            for index, io in enumerate(value):
                set_pin('D%d' % index, _io('D[%d]' % index, io))
            continue
        if not _valid_name(name):
            raise ValueError('invalid pin name %r' % name)
        set_pin(name, _io(name, value))
    return result


def pin(name):
    """Resolve a logical pin name to a chip IO number or raise ValueError."""
    if not isinstance(name, str):
        raise ValueError('pin name must be a string')
    values = pins()
    for candidate in _ALIASES.get(name, ()) + (name,):
        if candidate in values:
            return values[candidate]
    raise ValueError('board does not declare pin %r' % name)


def peripheral(name):
    """Return a deep copy of the declared sensor/lcd/sdcard section."""
    if name not in _PERIPHERALS:
        raise ValueError('unknown peripheral %r (expected one of %s)'
                         % (name, ', '.join(_PERIPHERALS)))
    section = _config.get_value(name, None)
    if not isinstance(section, dict):
        raise ValueError('board does not declare peripheral %r' % name)
    return _copy(section)
