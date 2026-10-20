# SPDX-License-Identifier: MIT
"""Source-built RAM ID reader candidate; NOT auto-loaded by the worker.

Only an audited image with the exact pinned SHA may reach the serial port.
ROM transport/reset sequences follow sipeed/kflash.py 1.1.6 at commit
550828c768b16ef329695d3f5eace3f6bcf14af2 (MIT, Copyright 2019 Vowstar).
The fixed ID packet is the Apache ktool DE format; its pure codec and notices
are documented in nodu_flash_protocol.py. No upstream embedded ISP is used.
"""

from collections import deque
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time

import nodu_flash_protocol as protocol


STUB_SHA256 = '6e9843b2bf365637af3853b1d827fc832a1a5ac4cd8dc5f203053bf5d29833a2'
STUB_SIZE = 8688
STUB_PATH = Path(__file__).with_name('flash-probe') / 'probe.bin'


class ProbeError(Exception):
    pass


def validate_build():
    if STUB_PATH.is_symlink() or not STUB_PATH.is_file():
        raise ProbeError('The reviewed source-built RAM reader is not installed.')
    if STUB_PATH.stat().st_size != STUB_SIZE:
        raise ProbeError('RAM reader length differs from the reviewed build; no port was opened.')
    image = STUB_PATH.read_bytes()
    if len(image) != STUB_SIZE or hashlib.sha256(image).hexdigest() != STUB_SHA256:
        raise ProbeError('RAM reader size/SHA256 differs from the reviewed build; no port was opened.')
    if importlib.metadata.version('pyserial') != '3.5':
        raise ProbeError('The RAM reader requires the reviewed pyserial==3.5 environment.')
    return image


def _pause(duration, check):
    end = time.monotonic() + duration
    while time.monotonic() < end:
        check()
        time.sleep(min(0.01, max(0, end - time.monotonic())))


def _reset_isp(port, check):
    # Fixed kflash reset_to_isp_dan sequence, already used successfully by
    # this physical board's CH340 transport. No alternate strategy guessing.
    port.dtr = False
    port.rts = False
    _pause(0.1, check)
    port.dtr = False
    port.rts = True
    _pause(0.1, check)
    port.rts = False
    port.dtr = True
    _pause(0.1, check)


def _reset_boot(port):
    # Recovery must still release BOOT/reset when the worker is cancelled.
    port.dtr = False
    port.rts = False
    _pause(0.1, lambda: None)
    port.dtr = False
    port.rts = True
    _pause(0.1, lambda: None)
    port.rts = False
    port.dtr = False
    _pause(0.1, lambda: None)


class _Link:
    def __init__(self, port, check):
        self.port = port
        self.check = check
        self.decoder = protocol.SlipDecoder(maximum=128)
        self.pending = deque()
        self.reset_diagnostics()

    def reset_diagnostics(self):
        # Counters only: never retain or print identity/UID response bytes.
        self.counters = dict(receivedBytes=0, receiveChunks=0, decodedFrames=0,
                             slipDelimiters=0, slipEscapeMarkers=0,
                             slipErrors=0, ignoredBootAcks=0)

    def _count(self, name, amount=1):
        self.counters[name] = min(0xFFFFFFFF, self.counters[name] + amount)

    def diagnostics(self):
        return dict(self.counters, pendingFrames=min(128, len(self.pending)),
                    partialFrameBytes=min(128, len(self.decoder._buffer)),
                    slipStarted=self.decoder._started,
                    slipEscaped=self.decoder._escaped)

    def clear(self):
        self.port.reset_input_buffer()
        self.decoder = protocol.SlipDecoder(maximum=128)
        self.pending.clear()

    def send(self, packet):
        self.check()
        frame = protocol.slip_encode(packet)
        if self.port.write(frame) != len(frame):
            raise ProbeError('Incomplete serial write; the RAM reader will not continue.')

    def receive(self, *, allow_boot_ack=False):
        end = time.monotonic() + 1.5
        ignored = 0
        while time.monotonic() < end:
            self.check()
            if self.pending:
                frame = self.pending.popleft()
                # A ROM C5 acknowledgement may arrive just after the program
                # starts. It is not a stub success or an identity response.
                if allow_boot_ack and frame in (b'\xc5\x00', b'\xc5\xe0'):
                    ignored += 1
                    self._count('ignoredBootAcks')
                    if ignored > 2:
                        raise ProbeError('Unexpected repeated ROM boot acknowledgements.')
                    continue
                return frame
            chunk = self.port.read(128)
            if chunk:
                if isinstance(chunk, bytes):
                    self._count('receivedBytes', len(chunk))
                    self._count('receiveChunks')
                    self._count('slipDelimiters', chunk.count(b'\xc0'))
                    self._count('slipEscapeMarkers', chunk.count(b'\xdb'))
                try:
                    frames = self.decoder.feed(chunk)
                except protocol.ProtocolError:
                    self._count('slipErrors')
                    raise
                self._count('decodedFrames', len(frames))
                self.pending.extend(frames)
        raise ProbeError('RAM identity transport timed out; capacity remains unverified.')

    def acknowledge(self, packet, operation, *, allow_boot_ack=False):
        self.send(packet)
        protocol.validate_ack(self.receive(allow_boot_ack=allow_boot_ack), operation)


def probe(port, *, check=lambda: None, log=lambda text: None, nonce=None, session=None):
    """Use the worker's existing PortLock; never independently certify reuse.

    The caller must save all recoverable files/boot bytes before closing REPL.
    Loading RAM ends the current runtime. Only the reader itself has a no-Flash-
    write command boundary: returning to firmware can run startup file writes.
    UID bytes are checked by the packet CRC, then discarded without logging.
    """
    image = validate_build()  # No serial object exists until all pins match.
    if not isinstance(port, str) or not port or '://' in port:
        raise ProbeError('A local worker-owned serial port is required.')
    if not isinstance(nonce, str) or len(nonce) != 32 or not isinstance(session, str) or not session:
        raise ProbeError('A fresh worker request and source session are required.')
    import serial
    deadline = time.monotonic() + 45

    def bounded_check():
        check()
        if time.monotonic() > deadline:
            raise ProbeError('RAM identity operation exceeded its fixed time bound.')

    connection = serial.Serial(port=None, baudrate=115200, timeout=0.05,
                               write_timeout=1, exclusive=True)
    opened = False
    link = None
    stage = {'stage': 'serial-open'}

    def mark_stage(name, **details):
        nonlocal stage
        stage = dict(stage=name, **details)
        if link is not None:
            link.reset_diagnostics()

    try:
        connection.dtr = False
        connection.rts = False
        connection.port = port
        connection.open()
        opened = True
        mark_stage('reset-isp')
        _reset_isp(connection, bounded_check)
        link = _Link(connection, bounded_check)
        link.clear()
        log('RAM identity: ROM handshake at 115200 baud; only fixed SRAM upload/boot commands are permitted.')
        for attempt in range(3):
            mark_stage('C2-handshake', attempt=attempt + 1)
            try:
                link.acknowledge(protocol.rom_nop_request(), 0xC2)
                break
            except (ProbeError, protocol.ProtocolError):
                if attempt == 2:
                    raise
                link.clear()
        for packet in protocol.rom_upload_packets(image):
            # A failed write/ACK never advances to C5 or executes a partial
            # image. No generic command or target address is accepted.
            address = int.from_bytes(packet[8:12], 'little')
            mark_stage('C3-upload', sramOffset=address - protocol.RAM_ENTRY,
                       sramAddress=address)
            link.acknowledge(packet, 0xC3)
        mark_stage('C5-boot')
        link.send(protocol.rom_boot_request())
        _pause(0.05, bounded_check)
        link.clear()
        mark_stage('D2-nop')
        link.acknowledge(protocol.stub_request(0xD2), 0xD2, allow_boot_ack=True)
        mark_stage('D7-init')
        link.acknowledge(protocol.stub_request(0xD7), 0xD7)
        identities = []
        for read_number in range(2):
            mark_stage('DE-identity', read=read_number + 1)
            link.send(protocol.stub_request(0xDE))
            identities.append(protocol.parse_jedec_response(link.receive()))
        if identities[0] != identities[1]:
            raise ProbeError('Repeated current JEDEC reads disagree; capacity remains unverified.')
        result = dict(identities[0], verified=True, probePort=port,
                      requestNonce=nonce, sessionBeforeProbe=session,
                      stubSha256=STUB_SHA256, stubBytes=STUB_SIZE,
                      source='source-built-kendryte-sdk-v0.5.6',
                      protocol='ktool-DE-fixed27-readonly', readAt=int(time.time() * 1000),
                      legacy90Check='enforced internally by the fixed RAM reader; raw bytes not returned')
        log('RAM identity: two CRC-checked, allowlisted current JEDEC responses agree. Returning to the installed firmware.')
    except (ProbeError, protocol.ProtocolError) as exc:
        # Preserve the exception object/type and all existing recovery paths.
        # Cancellation and unrelated exceptions are deliberately not caught.
        metadata = dict(stage, **(link.diagnostics() if link is not None else {}))
        exc.args = ('%s Failure metadata: %s' % (
            str(exc), json.dumps(metadata, sort_keys=True, separators=(',', ':'))),)
        raise
    finally:
        try:
            if opened:
                _reset_boot(connection)
        except Exception as exc:
            raise ProbeError('RAM reader exit could not restore the boot pins; reconnect recovery is required.') from exc
        finally:
            connection.close()
    return result
