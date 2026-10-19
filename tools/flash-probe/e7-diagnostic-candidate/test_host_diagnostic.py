# SPDX-License-Identifier: MIT
"""Offline protocol checks; no active parser, serial port, or device code."""

import unittest
import zlib

from host_diagnostic import parse_e7_diagnostic


# Fixed wire vector: zlib CRC32(DE E7 EF 40 16 EF 15) = F0D15065.
_VALID_FRAME = bytes.fromhex("dee7ef4016ef156550d1f0")


def _with_crc(payload):
    """Build malformed-header cases independently of parser CRC code."""
    return payload + (zlib.crc32(payload) & 0xFFFFFFFF).to_bytes(4, "little")


class E7DiagnosticTests(unittest.TestCase):
    def test_fixed_independent_crc_vector_and_fields(self):
        self.assertEqual(zlib.crc32(_VALID_FRAME[:7]), 0xF0D15065)
        self.assertEqual(_VALID_FRAME[7:], bytes.fromhex("6550d1f0"))
        self.assertEqual(
            parse_e7_diagnostic(_VALID_FRAME),
            {
                "authenticated": False,
                "capacityVerified": False,
                "jedecId": "ef4016",
                "legacy90": "ef15",
            },
        )

    def test_requires_exact_length(self):
        for frame in (b"", _VALID_FRAME[:1], _VALID_FRAME[:-1],
                      _VALID_FRAME + b"\x00"):
            with self.subTest(length=len(frame)):
                with self.assertRaises(ValueError):
                    parse_e7_diagnostic(frame)

    def test_rejects_other_opcode_even_with_valid_crc(self):
        with self.assertRaises(ValueError):
            parse_e7_diagnostic(_with_crc(b"\xd7\xe7" + _VALID_FRAME[2:7]))

    def test_rejects_other_status_even_with_valid_crc(self):
        for status in (0x00, 0xE0, 0xE6, 0xE8, 0xFF):
            with self.subTest(status=status):
                with self.assertRaises(ValueError):
                    parse_e7_diagnostic(
                        _with_crc(bytes((0xDE, status)) + _VALID_FRAME[2:7])
                    )

    def test_rejects_corrupt_payload_and_each_crc_byte(self):
        for index in range(2, 11):
            changed = bytearray(_VALID_FRAME)
            changed[index] ^= 1
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    parse_e7_diagnostic(bytes(changed))

    def test_crc_must_be_little_endian(self):
        with self.assertRaises(ValueError):
            parse_e7_diagnostic(_VALID_FRAME[:7] + _VALID_FRAME[7:][::-1])

    def test_any_ids_in_an_e7_frame_never_authenticate(self):
        # Even bytes matching the success allowlist cannot override E7 rejection.
        for ids in ("0000000000", "ffffffffff", "123456789a",
                    "ef4018ef17", "ef7018ef17"):
            with self.subTest(ids=ids):
                parsed = parse_e7_diagnostic(
                    _with_crc(b"\xde\xe7" + bytes.fromhex(ids))
                )
                self.assertIs(parsed["authenticated"], False)
                self.assertIs(parsed["capacityVerified"], False)
                self.assertEqual(parsed["jedecId"], ids[:6])
                self.assertEqual(parsed["legacy90"], ids[6:])
                self.assertEqual(
                    set(parsed),
                    {"authenticated", "capacityVerified", "jedecId", "legacy90"},
                )

    def test_accepts_only_exact_bytes_type(self):
        class BytesSubclass(bytes):
            pass

        for frame in (bytearray(_VALID_FRAME), memoryview(_VALID_FRAME),
                      _VALID_FRAME.hex(), list(_VALID_FRAME), None, 11,
                      BytesSubclass(_VALID_FRAME)):
            with self.subTest(type=type(frame).__name__):
                with self.assertRaises(TypeError):
                    parse_e7_diagnostic(frame)

    def test_rejects_success_frame_and_legacy_two_byte_e7(self):
        for frame in (b"\xde\x00" + bytes(25), b"\xde\xe7"):
            with self.subTest(length=len(frame)):
                with self.assertRaises(ValueError):
                    parse_e7_diagnostic(frame)

    def test_does_not_decode_slip(self):
        # Raw special bytes are data; the parser neither frames nor unescapes.
        raw = bytes.fromhex("dee7c0db01c0db3aeca8ae")
        parsed = parse_e7_diagnostic(raw)
        self.assertEqual(parsed["jedecId"], "c0db01")
        self.assertEqual(parsed["legacy90"], "c0db")
        escaped = raw.replace(b"\xdb", b"\xdb\xdd").replace(b"\xc0", b"\xdb\xdc")
        for framed in (b"\xc0" + _VALID_FRAME + b"\xc0", escaped,
                       b"\xc0" + escaped + b"\xc0"):
            with self.subTest(frame=framed.hex()):
                with self.assertRaises(ValueError):
                    parse_e7_diagnostic(framed)
