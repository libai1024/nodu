# SPDX-License-Identifier: MIT
"""stdlib unittest for nodu_board.py using a fake Maix.config (no hardware).

Run: python3 -m unittest discover -s examples/board-api -p 'test_*.py'
(from the desktop/ directory)
"""
import importlib
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


class FakeConfig:
    def __init__(self, values):
        self._values = values
        self.calls = []

    def get_value(self, key, default=None):
        self.calls.append(key)
        return self._values.get(key, default)

    # Any write attempt must fail loudly; nodu_board must never call these.
    def set_value(self, *args):
        raise AssertionError('nodu_board must not write config')

    def save(self, *args):
        raise AssertionError('nodu_board must not save config')


def load_module(values):
    """(Re)import nodu_board against a fresh fake Maix module."""
    maix = types.ModuleType('Maix')
    maix.config = FakeConfig(values)
    sys.modules['Maix'] = maix
    sys.modules.pop('nodu_board', None)
    module = importlib.import_module('nodu_board')
    return module, maix.config


class NoduBoardTest(unittest.TestCase):
    def test_alias_resolution(self):
        module, _ = load_module({'board_info': {'USER_LED': 17, 'BOOT_KEY': 16}})
        self.assertEqual(module.pin('LED'), 17)
        self.assertEqual(module.pin('BUTTON'), 16)
        self.assertEqual(module.pin('USER_LED'), 17)

    def test_led_falls_back_to_led_r(self):
        module, _ = load_module({'board_info': {'LED_R': 13, 'BOOT_KEY': 16}})
        self.assertEqual(module.pin('LED'), 13)

    def test_missing_pin_raises_no_default(self):
        module, _ = load_module({'board_info': {}})
        for name in ('LED', 'BUTTON', 'BOOT_KEY', 'NOPE'):
            with self.assertRaises(ValueError):
                module.pin(name)
        module, _ = load_module({})  # no board_info at all
        with self.assertRaises(ValueError):
            module.pin('BUTTON')

    def test_invalid_io_values_rejected(self):
        for bad in (True, False, -1, 48, 3.5, '16', None):
            module, _ = load_module({'board_info': {'X': bad}})
            with self.assertRaises(ValueError):
                module.pin('X')
            with self.assertRaises(ValueError):
                module.pins()

    def test_pins_copy_and_d_array(self):
        module, config = load_module({'board_info': {
            'BOOT_KEY': 16, 'D': [4, 5], 'pin_num': 3, 'pin_name': ['a']}})
        first = module.pins()
        self.assertEqual(first, {'BOOT_KEY': 16, 'D0': 4, 'D1': 5})
        first['BOOT_KEY'] = 0
        self.assertEqual(module.pins()['BOOT_KEY'], 16)
        # Synthesised D aliases resolve through pin(), in both call orders.
        self.assertEqual(module.pin('D0'), 4)
        self.assertEqual(module.pin('D1'), 5)
        with self.assertRaises(ValueError):
            module.pin('D2')
        with self.assertRaises(ValueError):
            module.pin('D')

    def test_malformed_names_and_d_collisions(self):
        for bad_name in ('9BAD', '', 'a' * 65, 'A B', 'A\nB', '引脚',
                         '__proto__', 'constructor', 'prototype'):
            module, _ = load_module({'board_info': {bad_name: 4, 'BOOT_KEY': 16}})
            with self.assertRaises(ValueError):
                module.pins()
        for doc in ({'D': [4], 'D0': 5}, {'D0': 5, 'D': [4]}):
            module, _ = load_module({'board_info': dict(doc)})
            with self.assertRaises(ValueError):
                module.pins()
        # An agreeing duplicate is fine.
        module, _ = load_module({'board_info': {'D': [4], 'D0': 4}})
        self.assertEqual(module.pin('D0'), 4)
        module, _ = load_module({'board_info': {'D': [4] * 49}})
        with self.assertRaises(ValueError):
            module.pins()
        for bad_meta in ({'pin_num': 49}, {'pin_num': -1}, {'pin_name': 'x'},
                         {'pin_name': ['a', 1]}):
            module, _ = load_module({'board_info': dict(bad_meta)})
            with self.assertRaises(ValueError):
                module.pins()

    def test_module_imports_without_regex(self):
        # MaixPy ships ure with no {m,n} support; the helper must not depend on
        # either regex module at all. Poison both and force a fresh import.
        saved_re = sys.modules.get('re')
        saved_ure = sys.modules.get('ure')
        sys.modules['re'] = None  # makes `import re` raise ImportError
        sys.modules['ure'] = None
        try:
            module, _ = load_module({'board_info': {'USER_LED': 17}})
            self.assertEqual(module.pin('LED'), 17)
        finally:
            if saved_re is None:
                sys.modules.pop('re', None)
            else:
                sys.modules['re'] = saved_re
            if saved_ure is None:
                sys.modules.pop('ure', None)
            else:
                sys.modules['ure'] = saved_ure

    def test_pin_rejects_non_string_names(self):
        module, _ = load_module({'board_info': {'BOOT_KEY': 16}})
        for bad in (None, 16, True, b'BOOT_KEY', 4.0):
            with self.assertRaises(ValueError):
                module.pin(bad)

    def test_peripheral_returns_deep_copy(self):
        module, _ = load_module({'sensor': {'pin_clk': 25, 'nested': {'a': [1, 2]},
                                            'items': (1, 2)}, 'lcd': {'rst': 29}})
        section = module.peripheral('sensor')
        self.assertEqual(section['nested'], {'a': [1, 2]})
        self.assertEqual(section['items'], [1, 2])
        section['nested']['a'][0] = 99
        section['items'].append(3)
        fresh = module.peripheral('sensor')
        self.assertEqual(fresh['nested']['a'][0], 1)
        self.assertEqual(fresh['items'], [1, 2])
        with self.assertRaises(ValueError):
            module.peripheral('wifi')
        module, _ = load_module({})
        with self.assertRaises(ValueError):
            module.peripheral('sdcard')

    def test_generated_snippets_run_against_stubs(self):
        # Mirrors the strings emitted by the UI detail panes: a peripheral
        # query and a synthesized D-alias lookup through nodu_board.
        module, _ = load_module({'board_info': {'D': [4, 5], 'BOOT_KEY': 16},
                                 'sensor': {'pin_clk': 25, 'pin_sda': 24}})
        printed = []
        env = {'print': printed.append}
        exec('from Maix import config\nprint(config.get_value("sensor", {})["pin_clk"])', env)
        self.assertEqual(printed, [25])
        printed.clear()
        env['nodu_board'] = module
        exec('import nodu_board\nprint(nodu_board.pin("D0"))', env)
        self.assertEqual(printed, [4])
        printed.clear()
        exec('import nodu_board\nprint(nodu_board.pin("BUTTON"))', env)
        self.assertEqual(printed, [16])

    def test_info_and_no_writes_on_import_or_calls(self):
        module, config = load_module({'type': 'embedfire', 'config_name': 'embedfire-k210',
                                      'board_info': {'BOOT_KEY': 16}})
        # Only get_value is exercised; FakeConfig raises on any write/save.
        result = module.info()
        self.assertEqual(result['type'], 'embedfire')
        self.assertEqual(result['config_name'], 'embedfire-k210')
        self.assertEqual(result['source'], '/flash/config.json')
        self.assertIn('Maix.config', result['read_via'])
        module.pins()
        self.assertTrue(set(config.calls) <= {'board_info', 'type', 'config_name'})


if __name__ == '__main__':
    unittest.main()
