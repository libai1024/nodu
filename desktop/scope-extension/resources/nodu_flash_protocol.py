"""Bounded, I/O-free codecs for the proposed source-built K210 ID reader.

Protocol references (reviewed before adaptation):
  sipeed/kflash.py 550828c768b16ef329695d3f5eace3f6bcf14af2,
    K210 write/boot/SLIP methods, MIT (Copyright 2019 Vowstar).
  loboris/ktool 0345aa90d9b3830641373fb4e3ce4edf45d0a46f,
    src/isp/main.c and isp.h DE packet/CRC layout, Apache-2.0
    (Copyright 2020 LoBo). No GPL slip.c/slip.h code is included.

This module does not open ports, load code, reset a board, or certify a session.
Passing synthetic bytes to its parser is never hardware-capacity evidence.
See tools/flash-probe/ and docs/automatic-flash-source-audit.md for the
separate, not-yet-hardware-validated loader candidate and source boundaries.
"""

import binascii
import struct


class ProtocolError(ValueError):
    pass


RAM_ENTRY = 0x80000000
MAX_IMAGE_BYTES = 65536
MAX_ROM_CHUNK = 1024
MAX_FRAME_BYTES = 16 + MAX_ROM_CHUNK
STUB_OPERATIONS = frozenset((0xD2, 0xD7, 0xDE))

# Winbond W25Q128JV Rev F (2018-03-27), identification table, p21.
# Only these complete, documented IDs are accepted. No 2**density shortcut,
# profile, partition size, historical ID, or wrapping read sets capacity.
SUPPORTED_IDS = {
    b'\xef\x40\x18': ('Winbond W25Q128 family', 16777216),
    b'\xef\x60\x18': ('Winbond W25Q128 family', 16777216),
    b'\xef\x70\x18': ('Winbond W25Q128 family', 16777216),
}


def _crc(data):
    return binascii.crc32(data) & 0xFFFFFFFF


def slip_encode(payload):
    if not isinstance(payload, bytes) or not 0 < len(payload) <= MAX_FRAME_BYTES:
        raise ProtocolError('Invalid or oversized SLIP payload.')
    return b'\xc0' + payload.replace(b'\xdb', b'\xdb\xdd').replace(b'\xc0', b'\xdb\xdc') + b'\xc0'


class SlipDecoder:
    """Incremental decoder; escaped bytes are appended exactly once.

    Unlike the reviewed upstream recv_one_return(), this does not append an
    escape suffix a second time after unescaping. Invalid escapes and overflow
    fail closed, rather than yielding partially decoded capacity metadata.
    """

    def __init__(self, maximum=MAX_FRAME_BYTES):
        if type(maximum) is not int or not 1 <= maximum <= MAX_FRAME_BYTES:
            raise ProtocolError('Invalid frame bound.')
        self.maximum = maximum
        self._buffer = bytearray()
        self._started = False
        self._escaped = False

    def feed(self, data):
        if not isinstance(data, bytes) or len(data) > 4096:
            self._reset()
            raise ProtocolError('Invalid or oversized serial read chunk.')
        frames = []
        for value in data:
            if value == 0xC0:
                if self._escaped:
                    self._reset()
                    raise ProtocolError('Truncated SLIP escape.')
                if self._started and self._buffer:
                    frames.append(bytes(self._buffer))
                self._buffer.clear()
                self._started = True
                continue
            if not self._started:
                continue
            if self._escaped:
                self._escaped = False
                if value == 0xDC:
                    value = 0xC0
                elif value == 0xDD:
                    value = 0xDB
                else:
                    self._reset()
                    raise ProtocolError('Invalid SLIP escape.')
            elif value == 0xDB:
                self._escaped = True
                continue
            self._buffer.append(value)
            if len(self._buffer) > self.maximum:
                self._reset()
                raise ProtocolError('SLIP response exceeds the fixed bound.')
        return frames

    def _reset(self):
        self._buffer.clear()
        self._started = False
        self._escaped = False


def rom_nop_request():
    # Exact existing kflash greeting payload (without the SLIP delimiters).
    return bytes.fromhex('c200000000000000000000000000')


def rom_upload_packets(image):
    """Return only C3 writes spanning this bounded image at fixed RAM_ENTRY.

    There is no caller-supplied target address, flash opcode, or jump target.
    This is packet construction only; callers must separately authenticate the
    built image's source and hash before any hardware execution is considered.
    """
    if not isinstance(image, bytes) or not 0 < len(image) <= MAX_IMAGE_BYTES:
        raise ProtocolError('RAM image must contain 1..65536 bytes.')
    packets = []
    for offset in range(0, len(image), MAX_ROM_CHUNK):
        chunk = image[offset:offset + MAX_ROM_CHUNK]
        body = struct.pack('<II', RAM_ENTRY + offset, len(chunk)) + chunk
        packets.append(struct.pack('<HHI', 0xC3, 0, _crc(body)) + body)
    return packets


def rom_boot_request():
    body = struct.pack('<II', RAM_ENTRY, 0)
    return struct.pack('<HHI', 0xC5, 0, _crc(body)) + body


def stub_request(operation):
    if type(operation) is not int or operation not in STUB_OPERATIONS:
        raise ProtocolError('Only NOP, controller initialization and ID are permitted.')
    body = struct.pack('<II', 0, 0)
    return struct.pack('<HHI', operation, 0, _crc(body)) + body


def validate_ack(payload, operation):
    if operation not in (0xC2, 0xC3, 0xD2, 0xD7):
        raise ProtocolError('Unexpected acknowledgement operation.')
    # Fixed kflash recv_debug accepts ROM's DEFAULT(0) and OK(E0); retain
    # those two statuses only for ROM C2/C3. Stub replies must always be E0.
    allowed = (bytes((operation, 0xE0)),)
    if operation in (0xC2, 0xC3):
        allowed += (bytes((operation, 0)),)
    if not isinstance(payload, bytes) or payload not in allowed:
        raise ProtocolError('Missing, mismatched or failed acknowledgement.')


def parse_jedec_response(payload):
    """Describe a CRC-checked, allowlisted DE response, without verified=True.

    The upstream DE response is exactly 27 bytes and retains data_len=0 in its
    16-byte header, followed by JEDEC[3] + UID[8]. Its CRC covers all 19 bytes
    after offset 8. The UID is deliberately discarded and never returned.
    Internal 90h cross-checking belongs to the separately audited RAM program;
    this result does not claim that the host received raw 90h bytes.
    """
    if not isinstance(payload, bytes) or len(payload) != 27:
        # Report framing/status metadata only. Never expose an unexpected
        # payload (which can contain the device UID) in logs or exceptions.
        if isinstance(payload, bytes):
            operation = '0x%02X' % payload[0] if payload else 'missing'
            status = '0x%02X' % payload[1] if len(payload) > 1 else 'missing'
            detail = 'received %d bytes, operation=%s, status=%s' % (
                len(payload), operation, status)
        else:
            detail = 'received a non-byte response'
        raise ProtocolError('ID response must be exactly 27 bytes; %s. Capacity remains unverified.' % detail)
    operation, reserved, checksum, address, data_length = struct.unpack('<HHIII', payload[:16])
    if (operation, reserved, address, data_length) != (0xDE, 0, 0, 0):
        raise ProtocolError('ID response header does not match the fixed protocol.')
    if checksum != _crc(payload[8:]):
        raise ProtocolError('ID response CRC32 mismatch; capacity is not accepted.')
    jedec = payload[16:19]
    if jedec not in SUPPORTED_IDS:
        raise ProtocolError('Unsupported physical JEDEC ID; capacity remains unverified.')
    family, capacity = SUPPORTED_IDS[jedec]
    return {'jedecId': jedec.hex().upper(), 'family': family,
            'capacityBytes': capacity, 'addressBytes': 3}
