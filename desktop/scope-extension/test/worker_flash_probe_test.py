"""Synthetic serial fixtures only: no real board, reset, RAM load or Flash I/O."""

import binascii
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest import mock

RESOURCES = Path(__file__).parents[1] / 'resources'
sys.path.insert(0, str(RESOURCES))
try:
    spec = importlib.util.spec_from_file_location('probe_candidate_subject', RESOURCES / 'nodu_flash_probe_candidate.py')
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
finally:
    sys.path.remove(str(RESOURCES))


def fixture_identity(jedec=b'\xef\x40\x18'):
    body = bytes(8) + jedec + b'UIDTEST!'
    return struct.pack('<HHI', 0xDE, 0, binascii.crc32(body) & 0xFFFFFFFF) + body


class SimulatedSerial:
    def __init__(self, *, fail_operation=None, corrupt_id=False, disagree=False):
        self.operations = []
        self.packets = []
        self.pending = bytearray()
        self.dtr = self.rts = False
        self.closed = False
        self.opened = False
        self.fail_operation = fail_operation
        self.corrupt_id = corrupt_id
        self.disagree = disagree
        self.id_reads = 0

    def open(self):
        self.opened = True

    def close(self):
        self.closed = True

    def reset_input_buffer(self):
        self.pending.clear()

    def write(self, frame):
        packet, = probe.protocol.SlipDecoder().feed(frame)
        operation = struct.unpack('<H', packet[:2])[0]
        self.operations.append(operation)
        self.packets.append(packet)
        if operation == self.fail_operation:
            reply = bytes((operation, 0xE3))
        elif operation == 0xDE:
            self.id_reads += 1
            jedec = b'\xef\x70\x18' if self.disagree and self.id_reads == 2 else b'\xef\x40\x18'
            reply = fixture_identity(jedec)
            if self.corrupt_id:
                reply = reply[:-1] + b'x'
        else:
            reply = bytes((operation, 0 if operation in (0xC2, 0xC3) else 0xE0))
        if operation == 0xD2:
            self.pending.extend(probe.protocol.slip_encode(b'\xc5\x00'))
        self.pending.extend(probe.protocol.slip_encode(reply))
        return len(frame)

    def read(self, size):
        data = bytes(self.pending[:size])
        del self.pending[:size]
        return data


class StageFailureSerial(SimulatedSerial):
    def __init__(self, operation, occurrence=1, *, repeat=False, kind='silent'):
        super().__init__()
        self.failure_operation = operation
        self.failure_occurrence = occurrence
        self.repeat = repeat
        self.kind = kind
        self.seen = 0

    def write(self, frame):
        written = super().write(frame)
        if self.operations[-1] != self.failure_operation:
            return written
        self.seen += 1
        if (self.seen != self.failure_occurrence and
                not (self.repeat and self.seen >= self.failure_occurrence)):
            return written
        self.pending.clear()
        if self.kind == 'short-write':
            return written - 1
        if self.kind == 'invalid-slip':
            self.pending.extend(b'\xc0\xdb\x00\xc0')
        return written


class FlashProbeCandidateTests(unittest.TestCase):
    def run_fixture(self, serial, *, check=lambda: None, modified=False):
        image = bytes(range(256)) * 8 + b'tail'
        logs = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'probe.bin'
            path.write_bytes(image if not modified else b'x' * len(image))
            factory = mock.Mock(return_value=serial)
            with mock.patch.object(probe, 'STUB_PATH', path), mock.patch.object(probe, 'STUB_SIZE', len(image)), mock.patch.object(probe, 'STUB_SHA256', hashlib.sha256(image).hexdigest()), mock.patch.object(probe.importlib.metadata, 'version', return_value='3.5'), mock.patch.object(probe, '_pause', side_effect=lambda duration, callback: callback()), mock.patch.dict(sys.modules, {'serial': types.SimpleNamespace(Serial=factory)}):
                result = probe.probe('/dev/synthetic-fixture-only', nonce='a' * 32,
                                     session='synthetic-session', check=check, log=logs.append)
            factory.assert_called_once_with(port=None, baudrate=115200, timeout=0.05,
                                            write_timeout=1, exclusive=True)
        return result, logs

    def test_synthetic_success_uses_only_fixed_ram_and_identity_operations(self):
        serial = SimulatedSerial()
        result, logs = self.run_fixture(serial)
        self.assertEqual(serial.operations, [0xC2, 0xC3, 0xC3, 0xC3, 0xC5, 0xD2, 0xD7, 0xDE, 0xDE])
        self.assertTrue(serial.closed)
        self.assertFalse(serial.dtr)
        self.assertFalse(serial.rts)
        self.assertEqual(result['capacityBytes'], 16777216)
        self.assertEqual(result['requestNonce'], 'a' * 32)
        self.assertEqual(result['sessionBeforeProbe'], 'synthetic-session')
        self.assertNotIn('UIDTEST!', json.dumps(result) + '\n'.join(logs))
        self.assertFalse(any('Failure metadata:' in item for item in logs))

    def failure_metadata(self, exception):
        text = str(exception)
        self.assertEqual(text.count('Failure metadata: '), 1)
        self.assertNotIn('UIDTEST!', text)
        return json.loads(text.split('Failure metadata: ', 1)[1])

    def test_stage_failures_report_exact_attempt_or_sram_offset_and_release(self):
        cases = ((0xC2, 1, True, 'silent', 'C2-handshake', {'attempt': 3}),
                 (0xC3, 2, False, 'silent', 'C3-upload',
                  {'sramOffset': 1024, 'sramAddress': 0x80000400}),
                 (0xC5, 1, False, 'short-write', 'C5-boot', {}),
                 (0xD2, 1, False, 'silent', 'D2-nop', {}),
                 (0xD7, 1, False, 'silent', 'D7-init', {}),
                 (0xDE, 1, False, 'silent', 'DE-identity', {'read': 1}),
                 (0xDE, 2, False, 'silent', 'DE-identity', {'read': 2}))
        for operation, occurrence, repeat, kind, stage, details in cases:
            with self.subTest(stage=stage, details=details):
                serial = StageFailureSerial(operation, occurrence, repeat=repeat, kind=kind)
                ticks = iter(index / 10 for index in range(10000))
                with mock.patch.object(probe.time, 'monotonic', side_effect=lambda: next(ticks)):
                    with self.assertRaises(probe.ProbeError) as error:
                        self.run_fixture(serial)
                metadata = self.failure_metadata(error.exception)
                self.assertEqual(metadata['stage'], stage)
                for key, value in details.items():
                    self.assertEqual(metadata[key], value)
                self.assertEqual(metadata['receivedBytes'], 0)
                self.assertEqual(metadata['decodedFrames'], 0)
                self.assertTrue(serial.closed)
                self.assertFalse(serial.dtr or serial.rts)
                if operation in (0xC2, 0xC3):
                    self.assertNotIn(0xC5, serial.operations)
                if operation == 0xC2:
                    self.assertEqual(serial.operations, [0xC2] * 3)

    def test_invalid_slip_reports_only_bounded_framing_counts(self):
        serial = StageFailureSerial(0xD2, kind='invalid-slip')
        with self.assertRaises(probe.protocol.ProtocolError) as error:
            self.run_fixture(serial)
        metadata = self.failure_metadata(error.exception)
        self.assertEqual(metadata['stage'], 'D2-nop')
        self.assertEqual(metadata['receivedBytes'], 4)
        self.assertEqual(metadata['receiveChunks'], 1)
        self.assertEqual(metadata['decodedFrames'], 0)
        self.assertEqual(metadata['slipDelimiters'], 2)
        self.assertEqual(metadata['slipEscapeMarkers'], 1)
        self.assertEqual(metadata['slipErrors'], 1)
        self.assertEqual(set(metadata), {'stage', 'receivedBytes', 'receiveChunks',
                         'decodedFrames', 'slipDelimiters', 'slipEscapeMarkers',
                         'slipErrors', 'ignoredBootAcks', 'pendingFrames',
                         'partialFrameBytes', 'slipStarted', 'slipEscaped'})
        self.assertTrue(serial.closed)
        self.assertFalse(serial.dtr or serial.rts)

    def test_protocol_error_object_and_ignored_boot_ack_are_preserved(self):
        serial = SimulatedSerial()
        failure = probe.protocol.ProtocolError('synthetic acknowledgement failure')
        original = probe.protocol.validate_ack

        def validate(payload, operation):
            if operation == 0xD2:
                raise failure
            return original(payload, operation)

        with mock.patch.object(probe.protocol, 'validate_ack', side_effect=validate):
            with self.assertRaises(probe.protocol.ProtocolError) as error:
                self.run_fixture(serial)
        self.assertIs(error.exception, failure)
        metadata = self.failure_metadata(error.exception)
        self.assertEqual(metadata['stage'], 'D2-nop')
        self.assertEqual(metadata['ignoredBootAcks'], 1)
        self.assertEqual(metadata['decodedFrames'], 2)
        self.assertTrue(serial.closed)
        self.assertFalse(serial.dtr or serial.rts)

    def test_diagnostic_counts_are_bounded_and_installed_host_is_identical(self):
        link = probe._Link(SimulatedSerial(), lambda: None)
        link._count('receivedBytes', 1 << 40)
        self.assertEqual(link.diagnostics()['receivedBytes'], 0xFFFFFFFF)
        self.assertEqual((RESOURCES / 'nodu_flash_probe_candidate.py').read_bytes(),
                         (RESOURCES / 'nodu_flash_probe.py').read_bytes())

    def test_upload_or_init_failure_never_runs_the_next_stage(self):
        for operation in (0xC3, 0xD7):
            serial = SimulatedSerial(fail_operation=operation)
            with self.subTest(operation=operation), self.assertRaises(probe.protocol.ProtocolError):
                self.run_fixture(serial)
            self.assertTrue(serial.closed)
            self.assertFalse(serial.dtr or serial.rts)
            if operation == 0xC3:
                self.assertNotIn(0xC5, serial.operations)
            self.assertNotIn(0xDE, serial.operations)

    def test_corrupted_or_disagreeing_id_cannot_return_capacity_proof(self):
        for serial in (SimulatedSerial(corrupt_id=True), SimulatedSerial(disagree=True)):
            with self.assertRaises((probe.ProbeError, probe.protocol.ProtocolError)) as error:
                self.run_fixture(serial)
            metadata = self.failure_metadata(error.exception)
            self.assertEqual(metadata['stage'], 'DE-identity')
            self.assertEqual(metadata['read'], 1 if serial.corrupt_id else 2)
            self.assertTrue(serial.closed)
            self.assertFalse(serial.dtr or serial.rts)

    def test_modified_build_is_rejected_before_a_port_is_opened(self):
        serial = SimulatedSerial()
        with self.assertRaisesRegex(probe.ProbeError, 'SHA256'):
            self.run_fixture(serial, modified=True)
        self.assertFalse(serial.opened)
        self.assertEqual(serial.operations, [])

    def test_cancellation_during_upload_restores_pins_without_booting_partial_code(self):
        serial = SimulatedSerial()
        class Cancelled(RuntimeError):
            pass
        cancellation = Cancelled('synthetic cancellation')

        def check():
            if 0xC3 in serial.operations:
                raise cancellation

        with self.assertRaisesRegex(Cancelled, 'synthetic cancellation') as error:
            self.run_fixture(serial, check=check)
        self.assertIs(error.exception, cancellation)
        self.assertNotIn('Failure metadata:', str(error.exception))
        self.assertTrue(serial.closed)
        self.assertFalse(serial.dtr or serial.rts)
        self.assertNotIn(0xC5, serial.operations)


if __name__ == '__main__':
    unittest.main()
