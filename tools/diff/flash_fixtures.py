#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Generate Python-side expected outputs for the nodu-kflash differential
fixtures. Every case records the exact bytes/dict/exception the Python
implementation produces; tests/diff.rs replays the same inputs through the
Rust port and must match byte-for-byte and message-for-message.
"""
import base64
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path

RESOURCES = Path(__file__).resolve().parents[2] / 'desktop' / 'scope-extension' / 'resources'
FIXTURES = Path(__file__).resolve().parents[2] / 'desktop' / 'native' / 'crates' / 'nodu-kflash' / 'tests' / 'fixtures'
sys.path.insert(0, str(RESOURCES))

import nodu_flash_protocol as protocol  # noqa: E402
import nodu_firmware as firmware  # noqa: E402


def load_worker_metadata():
    """Import backup_frame_metadata without pulling serial/mpremote deps."""
    source = (RESOURCES / 'nodu_device_worker.py').read_text()
    start = source.index('def backup_frame_metadata')
    end = source.index('\nclass PortLock', start)
    namespace = {'hashlib': hashlib}
    exec(source[start:end], namespace)
    return namespace['backup_frame_metadata']


def exc(fn, *args, **kwargs):
    try:
        return {'ok': fn(*args, **kwargs)}
    except Exception as e:
        return {'error': {'type': type(e).__name__, 'message': str(e)}}


def h(data):
    return data.hex() if isinstance(data, (bytes, bytearray)) else data


def unwrap(value):
    if isinstance(value, (bytes, bytearray)):
        return {'bytes': value.hex()}
    if isinstance(value, list) and value and isinstance(value[0], (bytes, bytearray)):
        return {'bytesList': [v.hex() for v in value]}
    return {'json': value}


cases = {}

# --- codec: slip_encode ---
slip = []
for payload in [b'\xd2', b'\xc0\xdb\x00\xff' * 7, bytes(range(256)),
                b'', b'x' * (protocol.MAX_FRAME_BYTES + 1),
                b'\xdb' * 64, b'\xc0' * 33]:
    slip.append({'input': h(payload), 'result': exc(lambda p=payload: {'bytes': protocol.slip_encode(p).hex()} if protocol.slip_encode(p) is not None else None)})
cases['slip_encode'] = slip

# --- codec: SlipDecoder feed sessions ---
def decode_session(chunks, maximum=128):
    decoder = protocol.SlipDecoder(maximum)
    out = []
    for chunk in chunks:
        try:
            out.append({'frames': [f.hex() for f in decoder.feed(bytes.fromhex(chunk))]})
        except Exception as e:
            out.append({'error': {'type': type(e).__name__, 'message': str(e)}})
        out[-1]['state'] = {'partial': len(decoder._buffer), 'started': decoder._started, 'escaped': decoder._escaped}
    return out

cases['slip_decode'] = [
    {'chunks': ['c0d2e0c0', 'c0c3e0c0'], 'result': decode_session(['c0d2e0c0', 'c0c3e0c0'])},
    {'chunks': ['ff' * 8 + 'c0' + 'aa' * 5, 'c0', 'de00c0c0d700c0'], 'result': decode_session(['ff' * 8 + 'c0' + 'aa' * 5, 'c0', 'de00c0c0d700c0'])},
    {'chunks': ['c0dbdcdbddc0'], 'result': decode_session(['c0dbdcdbddc0'])},
    {'chunks': ['c0dbc0'], 'result': decode_session(['c0dbc0'])},
    {'chunks': ['c0db41c0'], 'result': decode_session(['c0db41c0'])},
    {'chunks': ['c0' + 'aa' * 200], 'result': decode_session(['c0' + 'aa' * 200])},
    {'chunks': ['c0aa'], 'result': decode_session(['c0aa'])},
    {'chunks': ['c0aabb', 'c0'], 'result': decode_session(['c0aabb', 'c0'])},
]

# --- codec: fixed packets ---
cases['rom_nop_request'] = protocol.rom_nop_request().hex()
cases['rom_boot_request'] = protocol.rom_boot_request().hex()
cases['stub_request'] = [
    {'op': op, 'result': exc(lambda o=op: protocol.stub_request(o).hex())}
    for op in [0xD2, 0xD7, 0xDE, 0x00, 0xC3, 0xD1]
]

# --- codec: rom_upload_packets ---
up = []
for size in [0, 1, 1023, 1024, 1025, 3072, 65536, 65537]:
    image = bytes((i * 7 + size) & 0xFF for i in range(min(size, 70000)))
    r = exc(lambda im=image: [p.hex() for p in protocol.rom_upload_packets(im)])
    up.append({'size': size, 'image': image.hex(), 'result': r})
cases['rom_upload_packets'] = up

# --- codec: validate_ack ---
acks = []
for op in [0xC2, 0xC3, 0xD2, 0xD7, 0xDE, 0x00]:
    for payload in [bytes([op, 0xE0]), bytes([op, 0x00]), bytes([op, 0xE1]), b'', b'\xc2\xe0\xff']:
        acks.append({'op': op, 'payload': h(payload), 'result': exc(lambda p=payload, o=op: protocol.validate_ack(p, o) or True)})
cases['validate_ack'] = acks

# --- codec: parse_jedec_response ---
def jedec_payload(jedec, uid=b'\x01\x02\x03\x04\x05\x06\x07\x08'):
    body = b'\x00' * 8 + jedec + uid
    import struct as s
    return s.pack('<HHI', 0xDE, 0, protocol._crc(body)) + body

jedec = [
    {'payload': jedec_payload(b'\xef\x40\x18').hex(), 'result': exc(lambda: protocol.parse_jedec_response(jedec_payload(b'\xef\x40\x18')))},
    {'payload': jedec_payload(b'\xef\x70\x18').hex(), 'result': exc(lambda: protocol.parse_jedec_response(jedec_payload(b'\xef\x70\x18')))},
    {'payload': jedec_payload(b'\xc2\x20\x18').hex(), 'result': exc(lambda: protocol.parse_jedec_response(jedec_payload(b'\xc2\x20\x18')))},
    {'payload': (jedec_payload(b'\xef\x40\x18')[:-1]).hex(), 'result': exc(lambda: protocol.parse_jedec_response(jedec_payload(b'\xef\x40\x18')[:-1]))},
    {'payload': b''.hex(), 'result': exc(lambda: protocol.parse_jedec_response(b''))},
    {'payload': (b'\xde\xe0' + jedec_payload(b'\xef\x40\x18')[4:]).hex(), 'result': exc(lambda: protocol.parse_jedec_response(b'\xde\xe0' + jedec_payload(b'\xef\x40\x18')[4:]))},
]
bad_crc = bytearray(jedec_payload(b'\xef\x40\x18'))
bad_crc[4] ^= 0xFF
jedec.append({'payload': bytes(bad_crc).hex(), 'result': exc(lambda: protocol.parse_jedec_response(bytes(bad_crc)))})
bad_hdr = bytearray(jedec_payload(b'\xef\x40\x18'))
bad_hdr[8] = 1  # address field nonzero
# recompute crc so only the header check fires
import struct as _s
body = bytes(bad_hdr[8:])
bad_hdr[4:8] = _s.pack('<I', protocol._crc(body))
jedec.append({'payload': bytes(bad_hdr).hex(), 'result': exc(lambda: protocol.parse_jedec_response(bytes(bad_hdr)))})
cases['parse_jedec'] = jedec

# --- crc32 ---
cases['crc32'] = [
    {'input': d.hex(), 'result': protocol._crc(d)}
    for d in [b'', b'\x00', b'123456789', bytes(range(256)) * 4]
]

# --- worker backup_frame_metadata ---
frame_meta = load_worker_metadata()
lines = [
    b'NODU_DATA 00000000:' + base64.b64encode(b'hello' * 600).strip(),
    b'NODU_DATA 00000ff0:' + base64.b64encode(bytes(range(64))).strip(),
    b'NODU_DATA 00000ff0',  # missing colon
    b'NODU_DATA zzzzzz00:aGk=',  # bad offset hex
    b'NODU_DATA 00000000:aGk=!@#',  # invalid base64 chars
    b'NODU_DATA 00000000:aGk=\r\n'[:-2] + b'\x80\xff',
    b'NODU_FILL 00001000:ff:03072',
    b'NODU_SHA256 ' + b'a' * 64,
    b'NODU_SHA256 ' + b'A' * 64,
    b'NODU_SHA256 short',
    b'>>> ',
    b'raw REPL; CTRL-B to exit',
    b'OKabc',
    b'random garbage',
    b'',
    b'NODU_DATA ' + b'f' * 8 + b':' + b'A' * 4000 + b'\x00bad',
]
cases['backup_frame_metadata'] = [
    {'line': l.hex(), 'expected': 3072, 'result': frame_meta(l, 3072)} for l in lines
] + [
    {'line': lines[0].hex(), 'expected': 37, 'result': frame_meta(lines[0], 37)},
]

# --- firmware: dump_script / boot_region / plan ---
cases['dump_script'] = [
    {'size': s, 'remote': r, 'offset': o,
     'result': exc(lambda s=s, r=r, o=o: firmware.dump_script(s, r, o))}
    for s, r, o in [
        (16777216, None, 0), (4096, None, 4096), (16777216, None, 4096),
        (1, '/flash/main.py', 0), (134217728, '/flash/m.bin', 0),
        (1024, "/we'ird\npath.py", 0), (0, None, 0),
        (16777217, None, 0), (10, '', 0), (10, 'a\x00b', 0),
    ]
]

def boot_image(flag=0x02, payload_len=1024):
    import struct as s
    payload = bytes((i * 31 + 5) & 0xFF for i in range(payload_len))
    digest = hashlib.sha256(bytes([flag]) + s.pack('<I', payload_len) + payload).digest()
    return bytes([flag]) + s.pack('<I', payload_len) + digest + payload + b'\xff' * 100

good = boot_image()
boots = []
for data in [good, boot_image(flag=0x00), good[:30], good[:36],
             bytes([0x03]) + good[1:],  # bad flag
             good[:5] + b'\x00' + good[6:],  # corrupt length area -> crc? actually changes len byte
             good[:10] + b'\xff' * 32 + good[42:],  # wrong digest
             ]:
    r = exc(lambda d=data: firmware.boot_region(d))
    if 'ok' in r:
        meta, region = r['ok']
        r = {'ok': {'meta': meta, 'region': region.hex()}}
    boots.append({'input': data.hex(), 'result': r})
# a zero-length payload edge case
import struct as _st
empty_payload = b''
z = bytes([0x02]) + _st.pack('<I', 0) + hashlib.sha256(bytes([0x02]) + _st.pack('<I', 0)).digest()
boots.append({'input': z.hex(), 'result': (lambda rr: {'ok': {'meta': rr['ok'][0], 'region': rr['ok'][1].hex()}} if 'ok' in rr else rr)(exc(lambda: firmware.boot_region(z)))})
cases['boot_region'] = boots

cases['plan'] = firmware.plan()

# --- py_int_base: Python int(field, 16) edge cases for the 8-byte headers ---
cases['py_int_base'] = [
    {'input': d.hex(), 'result': exc(lambda d=d: int(d, 16))}
    for d in [
        b'000000ff', b'000000FF', b'      ff', b'ff      ', b'-00000ff',
        b'+00000ff', b'0x0000ff', b'0X0000FF', b'gg000000', b'',
        b'000_00ff', b'0_f', b'_0ff', b'0ff_', b'0__ff', b'f_f_f', b'f__f',
        b'\x0bff', b'ff\x0b', b'\x0b', b'0x_1f', b'0x__1f', b'-_1f', b'+_1f',
        b'0x 1f', b'0 x1f', b'\xff\xff\xff\xff\xff\xff\xff\xff', b'7fffffff',
        b'ffffffff', b'1000000000000000', b'99999999', b'cafeBEEF',
    ]
]

# --- BackupReceiver: full scenario replays (DATA/FILL/SHA256 lines) ---
def run_backup_scenario(size, lines):
    """Feed lines through firmware.BackupReceiver; record per-line outcome,
    progress calls, and finish() result. Errors do not stop the feed — the
    receiver object keeps accepting lines, so both sides must match on the
    continuing state too."""
    import base64 as b64
    with tempfile.TemporaryDirectory() as td:
        dest = Path(td) / 'out.bin'
        progress_events = []
        try:
            receiver = firmware.BackupReceiver(dest, size,
                                               lambda r, t: progress_events.append([r, t]))
        except Exception as e:
            return {'initError': {'type': type(e).__name__, 'message': str(e)}}
        per_line = []
        for line in lines:
            try:
                receiver.line(bytes.fromhex(line))
                per_line.append({'ok': True})
            except Exception as e:
                per_line.append({'error': {'type': type(e).__name__, 'message': str(e)}})
        try:
            digest = receiver.finish()
            finish = {'ok': digest}
        except Exception as e:
            finish = {'error': {'type': type(e).__name__, 'message': str(e)}}
        written = dest.read_bytes().hex() if dest.exists() else None
        return {'lines': per_line, 'progress': progress_events,
                'finish': finish, 'written': written}


def _data(offset, payload):
    return (b'NODU_DATA %08x:' % offset) + base64.b64encode(payload)


def _fill(offset, value, count):
    return b'NODU_FILL %08x:%02x:%d' % (offset, value, count)


def _sha(data):
    return b'NODU_SHA256 ' + hashlib.sha256(data).hexdigest().encode()


def _sha_wrong():
    return b'NODU_SHA256 ' + b'0' * 64


chunk_a = bytes((i * 3 + 1) & 0xFF for i in range(3072))
chunk_b = bytes((i * 5 + 2) & 0xFF for i in range(928))
whole = chunk_a + chunk_b
whole_sha = hashlib.sha256(whole).hexdigest().encode()
fill_data = b'\xff' * 3072 + b'\x00' * 928
fill_sha = hashlib.sha256(fill_data).hexdigest().encode()

cases['backup_receiver'] = [
    {'name': 'happy-data', 'size': 4000,
     'lines': [_data(0, chunk_a).hex(), _data(0xC00, chunk_b).hex(),
               (b'NODU_SHA256 ' + whole_sha).hex()],
     'result': run_backup_scenario(4000, [_data(0, chunk_a).hex(), _data(0xC00, chunk_b).hex(),
                                          (b'NODU_SHA256 ' + whole_sha).hex()])},
    {'name': 'happy-fill', 'size': 4000,
     'lines': [_fill(0, 0xFF, 3072).hex(), _fill(0xC00, 0x00, 928).hex(),
               (b'NODU_SHA256 ' + fill_sha).hex()],
     'result': run_backup_scenario(4000, [_fill(0, 0xFF, 3072).hex(), _fill(0xC00, 0x00, 928).hex(),
                                          (b'NODU_SHA256 ' + fill_sha).hex()])},
    {'name': 'data-after-hash', 'size': 100,
     'lines': [_sha_wrong().hex(), _data(0, b'x' * 100).hex()],
     'result': run_backup_scenario(100, [_sha_wrong().hex(), _data(0, b'x' * 100).hex()])},
    {'name': 'offset-mismatch', 'size': 4000,
     'lines': [_data(8, chunk_a).hex()],
     'result': run_backup_scenario(4000, [_data(8, chunk_a).hex()])},
    {'name': 'chunk-size-mismatch', 'size': 4000,
     'lines': [_data(0, chunk_a[:100]).hex()],
     'result': run_backup_scenario(4000, [_data(0, chunk_a[:100]).hex()])},
    {'name': 'fill-bad-fields', 'size': 4000,
     'lines': [b'NODU_FILL xyz'.hex(), b'NODU_FILL 00000000:ff'.hex(),
               b'NODU_FILL 00000000:fg:3072'.hex(), b'NODU_FILL 00000000:ff:abc'.hex(),
               b'NODU_FILL 00000000:ff:0'.hex(), b'NODU_FILL 000000000:ff:3072'.hex(),
               b'NODU_FILL 0000000G:ff:3072'.hex()],
     'result': run_backup_scenario(4000, [b'NODU_FILL xyz'.hex(), b'NODU_FILL 00000000:ff'.hex(),
                                          b'NODU_FILL 00000000:fg:3072'.hex(),
                                          b'NODU_FILL 00000000:ff:abc'.hex(),
                                          b'NODU_FILL 00000000:ff:0'.hex(),
                                          b'NODU_FILL 000000000:ff:3072'.hex(),
                                          b'NODU_FILL 0000000G:ff:3072'.hex()])},
    {'name': 'fill-wrong-count', 'size': 4000,
     'lines': [_fill(0, 0xFF, 100).hex()],
     'result': run_backup_scenario(4000, [_fill(0, 0xFF, 100).hex()])},
    {'name': 'sha-invalid', 'size': 4000,
     'lines': [(b'NODU_SHA256 ' + b'A' * 64).hex(), b'NODU_SHA256 short'.hex(),
               (b'NODU_SHA256 ' + b'\x80' + b'a' * 63).hex()],
     'result': run_backup_scenario(4000, [(b'NODU_SHA256 ' + b'A' * 64).hex(),
                                          b'NODU_SHA256 short'.hex(),
                                          (b'NODU_SHA256 ' + b'\x80' + b'a' * 63).hex()])},
    {'name': 'sha-duplicate', 'size': 4000,
     'lines': [_sha_wrong().hex(), _sha_wrong().hex()],
     'result': run_backup_scenario(4000, [_sha_wrong().hex(), _sha_wrong().hex()])},
    {'name': 'unexpected-lines', 'size': 4000,
     'lines': [b'hello'.hex(), b''.hex(), b'>>> '.hex(), b'NODU_DATA 0000'.hex(),
               b'NODU_DATA 00000000!aGk='.hex()],
     'result': run_backup_scenario(4000, [b'hello'.hex(), b''.hex(), b'>>> '.hex(),
                                          b'NODU_DATA 0000'.hex(),
                                          b'NODU_DATA 00000000!aGk='.hex()])},
    {'name': 'line-too-long', 'size': 4000,
     'lines': [(b'NODU_DATA ' + b'A' * 4200).hex()],
     'result': run_backup_scenario(4000, [(b'NODU_DATA ' + b'A' * 4200).hex()])},
    {'name': 'data-bad-b64', 'size': 4000,
     'lines': [(b'NODU_DATA 00000000:' + b'aGk= !!!').hex()],
     'result': run_backup_scenario(4000, [(b'NODU_DATA 00000000:' + b'aGk= !!!').hex()])},
    {'name': 'offset-hex-variants', 'size': 4000,
     'lines': [_data(0, chunk_a).hex(),
               (b'NODU_DATA 000_0c00:' + base64.b64encode(chunk_b)).hex(),
               (b'NODU_SHA256 ' + whole_sha).hex()],
     'result': run_backup_scenario(4000, [_data(0, chunk_a).hex(),
                                          (b'NODU_DATA 000_0c00:' + base64.b64encode(chunk_b)).hex(),
                                          (b'NODU_SHA256 ' + whole_sha).hex()])},
    {'name': 'finish-incomplete', 'size': 4000,
     'lines': [_data(0, chunk_a).hex()],
     'result': run_backup_scenario(4000, [_data(0, chunk_a).hex()])},
    {'name': 'finish-wrong-sha', 'size': 4000,
     'lines': [_data(0, chunk_a).hex(), _data(0xC00, chunk_b).hex(), _sha_wrong().hex()],
     'result': run_backup_scenario(4000, [_data(0, chunk_a).hex(), _data(0xC00, chunk_b).hex(),
                                          _sha_wrong().hex()])},
    {'name': 'overflow-size', 'size': 3072,
     'lines': [_data(0, chunk_a).hex(), _data(0xC00, b'x' * 10).hex()],
     'result': run_backup_scenario(3072, [_data(0, chunk_a).hex(), _data(0xC00, b'x' * 10).hex()])},
]

# --- pyjson dumps ---
values = [
    {'a': 1, 'b': [True, None, 'x'], 'c': {'n': -1.5}},
    {'unicode': 'héllo·世界\u0001', 'z': []},
    {},
    {'emoji': '\U0001F600', 'key': 'v'},
    [1, 'two', {'k': None}],
    {'dup': 1, 'deep': {'x': [1.0, 2e3]}},
]
cases['pyjson'] = [
    {'value': v, 'indent2': json.dumps(v, indent=2, ensure_ascii=True),
     'compact': json.dumps(v, separators=(',', ':'), ensure_ascii=True),
     'sorted': json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=True)}
    for v in values
]

# strict loads cases
strict = []
for text in ['{"a":1,"a":2}', '{"a":1}', 'not json', '{"a":}', '[1,2,]', '{"a":1,"b":{"a":3,"a":4}}', 'null', '"s"', '3.5']:
    try:
        r = firmware.json.loads(text, object_pairs_hook=firmware._restore_json_object)
        strict.append({'input': text, 'ok': r})
    except Exception as e:
        strict.append({'input': text, 'error': {'type': type(e).__name__, 'message': str(e)}})
cases['loads_strict'] = strict

# --- deflate: raw stream bytes ---
defl = []
for data in [b'', b'a', b'abc' * 8, bytes(range(256)), os.urandom(4096), b'\x00' * 100000]:
    c = zlib.compressobj(-1, zlib.DEFLATED, -15)
    packed = c.compress(data) + c.flush()
    defl.append({'input': data.hex(), 'packed': packed.hex()})
cases['deflate'] = defl

# --- kfpkg write_package byte identity ---
with tempfile.TemporaryDirectory() as td:
    src = Path(td) / 'full-flash.raw.bin'
    payload = bytes((i * 13 + 7) & 0xFF for i in range(8192))
    src.write_bytes(payload)
    os.utime(src, (946684800, 946684800))  # 2000-01-01 local
    pkg = io.BytesIO()
    with zipfile.ZipFile(pkg, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(src, src.name)
        archive.writestr('flash-list.json', json.dumps({'version': '0.1.0', 'files': [
            {'address': '0x00000000', 'bin': src.name, 'sha256Prefix': False}]},
            separators=(',', ':')))
    info = zipfile.ZipFile(io.BytesIO(pkg.getvalue())).getinfo(src.name)
    cases['kfpkg'] = {
        'data': payload.hex(),
        'mtime': 946684800,
        'dostime': '%04x' % ((info.date_time[3] << 11) | (info.date_time[4] << 5) | (info.date_time[5] // 2)),
        'dosdate': '%04x' % (((info.date_time[0] - 1980) << 9) | (info.date_time[1] << 5) | info.date_time[2]),
        'mode': '%x' % (info.external_attr >> 16),
        'package': pkg.getvalue().hex(),
    }

# --- validate_restore_package: good package + mutations ---
with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    raw = td / 'full-flash.raw.bin'
    payload = bytes((i * 13 + 7) & 0xFF for i in range(4096))
    raw.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    pkg_path = td / 'full-flash-restore.kfpkg'
    with open(pkg_path, 'wb') as f:
        with zipfile.ZipFile(f, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(raw, raw.name)
            archive.writestr('flash-list.json', json.dumps({'version': '0.1.0', 'files': [
                {'address': '0x00000000', 'bin': raw.name, 'sha256Prefix': False}]},
                separators=(',', ':')))
    good_bytes = pkg_path.read_bytes()
    def vcase(name, blob, size, sha, pkg=pkg_path):
        return {'name': name, 'bytes': blob.hex(), 'size': size, 'sha': sha,
                'result': exc(lambda: firmware._validate_restore_package(pkg, 'full-flash.raw.bin', size, sha, lambda: None))}
    val_cases = [vcase('valid', good_bytes, len(payload), digest)]
    # truncate / corrupt
    for i, mutant in enumerate([good_bytes[:-1], good_bytes[:20],
                                good_bytes[:-22] + b'\x00' * 22,
                                good_bytes[:10] + b'\x00' + good_bytes[11:]]):
        p = td / f'mut{i}.kfpkg'
        p.write_bytes(mutant)
        val_cases.append(vcase(f'mut{i}', mutant, len(payload), digest, pkg=p))
    # wrong expected sha
    val_cases.append(vcase('bad-sha', good_bytes, len(payload), '0' * 64))
cases['validate_restore_package'] = val_cases

FIXTURES.mkdir(parents=True, exist_ok=True)
out = FIXTURES / 'python-expected.json'
out.write_text(json.dumps(cases, indent=1))
print(f'wrote {out} ({out.stat().st_size} bytes, {len(cases)} sections)')
