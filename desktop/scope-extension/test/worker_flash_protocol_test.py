"""Offline synthetic protocol fixtures. These never open a serial device."""

import binascii
import importlib.util
from pathlib import Path
import struct
import unittest


path = Path(__file__).parents[1] / 'resources' / 'nodu_flash_protocol.py'
spec = importlib.util.spec_from_file_location('nodu_flash_protocol', path)
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)


def id_fixture(jedec=b'\xef\x40\x18', *, operation=0xDE, reserved=0, address=0, length=0):
    body = struct.pack('<II', address, length) + jedec + b'\xc0\xdb\xdc\xdd\x00\x01\x02\x03'
    return struct.pack('<HHI', operation, reserved, binascii.crc32(body) & 0xFFFFFFFF) + body


class FlashProtocolTests(unittest.TestCase):
    def test_slip_fragmentation_and_escaped_bytes_are_not_duplicated(self):
        original = id_fixture()
        encoded = protocol.slip_encode(original)
        for width in (1, 2, 7, 4096):
            with self.subTest(width=width):
                decoder, actual = protocol.SlipDecoder(maximum=27), []
                for index in range(0, len(encoded), width):
                    actual.extend(decoder.feed(encoded[index:index + width]))
                self.assertEqual(actual, [original])

    def test_multiple_frames_ignore_noise_and_empty_delimiters(self):
        decoder = protocol.SlipDecoder()
        data = b'noise\xc0\xc0' + protocol.slip_encode(b'\xd2\xe0') + protocol.slip_encode(b'\xd7\xe0')
        self.assertEqual(decoder.feed(data), [b'\xd2\xe0', b'\xd7\xe0'])

    def test_bad_escape_and_overflow_never_yield_partial_response(self):
        for data in (b'\xc0\xdb\x00\xc0', b'\xc0\xdb\xc0', b'\xc0' + b'x' * 28):
            with self.subTest(data=data), self.assertRaises(protocol.ProtocolError):
                protocol.SlipDecoder(maximum=27).feed(data)
        decoder = protocol.SlipDecoder(maximum=27)
        self.assertEqual(decoder.feed(b'\xc0partial'), [])
        with self.assertRaises(protocol.ProtocolError):
            decoder.feed(b'x' * 4097)
        self.assertEqual(decoder.feed(b'not-a-frame'), [])
        self.assertEqual(decoder.feed(protocol.slip_encode(b'\xd2\xe0')), [b'\xd2\xe0'])
        for invalid in (None, b'\xc0\xdb\x00', b'\xc0' + b'x' * 28):
            decoder.feed(b'\xc0partial')
            with self.assertRaises(protocol.ProtocolError):
                decoder.feed(invalid)
            self.assertEqual(decoder.feed(b'noise' + protocol.slip_encode(b'\xd7\xe0')), [b'\xd7\xe0'])

    def test_only_documented_complete_jedec_ids_are_described(self):
        for jedec in (b'\xef\x40\x18', b'\xef\x70\x18'):
            result = protocol.parse_jedec_response(id_fixture(jedec))
            self.assertEqual(result['capacityBytes'], 16777216)
            self.assertEqual(result['jedecId'], jedec.hex().upper())
            self.assertNotIn('verified', result)
            self.assertNotIn('uid', result)
        for jedec in (b'\x00' * 3, b'\xff' * 3, b'\xef\x40\x17', b'\x00\x40\x18', b'\xef\x40\x19'):
            with self.subTest(jedec=jedec), self.assertRaises(protocol.ProtocolError):
                protocol.parse_jedec_response(id_fixture(jedec))

    def test_crc_length_and_every_header_field_fail_closed(self):
        original = id_fixture()
        for data in (original[:-1], original + b'\x00', original[:20] + b'\xff' + original[21:]):
            with self.assertRaises(protocol.ProtocolError):
                protocol.parse_jedec_response(data)
        for field, value in (('operation', 0xD4), ('reserved', 1), ('address', 1), ('length', 11)):
            with self.subTest(field=field), self.assertRaises(protocol.ProtocolError):
                protocol.parse_jedec_response(id_fixture(**{field: value}))

    def test_failed_id_reports_only_framing_metadata_and_never_payload(self):
        for payload in (b'\xde\xe5', b'\xde\xe5PRIVATE_DEVICE_PAYLOAD', b'', None):
            with self.subTest(payload=payload), self.assertRaises(protocol.ProtocolError) as error:
                protocol.parse_jedec_response(payload)
            text = str(error.exception)
            self.assertIn('Capacity remains unverified', text)
            self.assertNotIn('PRIVATE_DEVICE_PAYLOAD', text)
        with self.assertRaisesRegex(protocol.ProtocolError,
                                    'received 2 bytes, operation=0xDE, status=0xE5'):
            protocol.parse_jedec_response(b'\xde\xe5')

    def test_ram_upload_is_contiguous_bounded_and_has_checked_body(self):
        image = bytes(range(256)) * 6 + b'tail'
        packets = protocol.rom_upload_packets(image)
        recovered, address = bytearray(), protocol.RAM_ENTRY
        for packet in packets:
            operation, reserved, checksum, target, length = struct.unpack('<HHIII', packet[:16])
            self.assertEqual((operation, reserved, target), (0xC3, 0, address))
            self.assertEqual(length, len(packet) - 16)
            self.assertLessEqual(length, 1024)
            self.assertEqual(checksum, binascii.crc32(packet[8:]) & 0xFFFFFFFF)
            recovered.extend(packet[16:])
            address += length
        self.assertEqual(bytes(recovered), image)
        for invalid in (b'', b'x' * 65537, bytearray(b'x')):
            with self.assertRaises(protocol.ProtocolError):
                protocol.rom_upload_packets(invalid)
        self.assertEqual(len(protocol.rom_upload_packets(b'x' * 65536)), 64)

    def test_fixed_boot_address_and_stub_write_opcodes_are_unavailable(self):
        packet = protocol.rom_boot_request()
        self.assertEqual(struct.unpack('<HHIII', packet),
                         (0xC5, 0, binascii.crc32(packet[8:]) & 0xFFFFFFFF, 0x80000000, 0))
        for operation in range(256):
            if operation in (0xD2, 0xD7, 0xDE):
                self.assertEqual(len(protocol.stub_request(operation)), 16)
            else:
                with self.assertRaises(protocol.ProtocolError):
                    protocol.stub_request(operation)

    def test_ack_requires_expected_opcode_and_success(self):
        for operation in (0xC2, 0xC3, 0xD2, 0xD7):
            protocol.validate_ack(bytes((operation, 0xE0)), operation)
            for reply in (bytes((operation, 0xE3)), b'', bytes((operation, 0xE0, 0))):
                with self.assertRaises(protocol.ProtocolError):
                    protocol.validate_ack(reply, operation)
            if operation in (0xC2, 0xC3):
                protocol.validate_ack(bytes((operation, 0)), operation)
            else:
                with self.assertRaises(protocol.ProtocolError):
                    protocol.validate_ack(bytes((operation, 0)), operation)
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_ack(b'\xd4\xe0', 0xD4)


if __name__ == '__main__':
    unittest.main()
