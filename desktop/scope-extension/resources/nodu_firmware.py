# SPDX-License-Identifier: MIT
"""Pinned firmware cache, bounded backup framing and K210 boot validation.

All device I/O is supplied by the worker; importing this module opens no port.
"""
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import tempfile
import urllib.request
import zipfile
import zlib

VERSION = 'maixpy_v0.6.3_2_gd8901fd22'
URL = 'https://dl.sipeed.com/fileList/MAIX/MaixPy/release/master/' + VERSION + '/' + VERSION + '.bin'
SHA256 = '6dde2d59adc344ee0c7f96300528b4feff5e36c160f5cc0066016389394f15fa'
SIZE = 2116288
WRITE_BYTES = SIZE + 37
SECTOR_END = (WRITE_BYTES + 4095) // 4096 * 4096
FLASH_BYTES = 16 * 1024 * 1024
CHUNK_BYTES = 3072
MAX_USER_FILE = 128 * 1024 * 1024
MAX_USER_TOTAL = 256 * 1024 * 1024


class FirmwareError(Exception):
    pass


def private_directory(value, fresh=False):
    if not isinstance(value, str) or not os.path.isabs(value):
        raise FirmwareError('Backup/cache directory must be an absolute backend-managed path.')
    path = Path(value)
    if path.is_symlink():
        raise FirmwareError('Backup/cache directory must not be a symbolic link.')
    if fresh and path.exists():
        raise FirmwareError('Backup directory already exists; use a new directory.')
    missing = []
    ancestor = path
    while not ancestor.exists():
        missing.append(ancestor)
        ancestor = ancestor.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
    path.chmod(0o700)
    return path


def private_file(path, mode='xb'):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if mode == 'xb' else os.O_TRUNC)
    descriptor = os.open(path, flags, 0o600)
    return os.fdopen(descriptor, 'wb')


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    # The only overwritten file is this operation's own manifest.
    with private_file(path, 'wb') as stream:
        stream.write((json.dumps(value, indent=2, ensure_ascii=True) + '\n').encode())
        stream.flush()
        os.fsync(stream.fileno())


def plan():
    return {'version': VERSION, 'url': URL, 'sha256': SHA256, 'address': 0,
            'size': SIZE, 'writeBytes': WRITE_BYTES, 'sectorEnd': SECTOR_END,
            'ready': True}


def validate_image(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != SIZE:
        raise FirmwareError('Official firmware image size is not the pinned 2116288 bytes.')
    if file_sha256(path) != SHA256:
        raise FirmwareError('Official firmware image SHA256 does not match the pinned release.')
    return path


def prepare(cache_dir, source_file=None, check=lambda: None, log=lambda text: None):
    root = private_directory(cache_dir)
    destination = root / (VERSION + '.bin')
    if destination.exists():
        try:
            validate_image(destination)
            destination.chmod(0o600)
            log('Official firmware cache verified (SHA256).')
            return destination
        except FirmwareError:
            # Do not silently replace an unrelated existing file.
            raise FirmwareError('Existing firmware cache is invalid; move it aside before preparing again.') from None
    descriptor, name = tempfile.mkstemp(prefix='.firmware-', suffix='.part', dir=root)
    os.chmod(name, 0o600)
    temporary = Path(name)
    try:
        if source_file and Path(source_file).exists():
            source = validate_image(source_file)
            incoming = open(source, 'rb')
            log('Copying the verified official firmware from the local installation.')
        else:
            log('Downloading the pinned official MaixPy firmware.')
            incoming = urllib.request.urlopen(URL, timeout=20)
        received = 0
        digest = hashlib.sha256()
        with os.fdopen(descriptor, 'wb') as output, incoming:
            descriptor = None
            while True:
                check()
                chunk = incoming.read(64 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > SIZE:
                    raise FirmwareError('Official firmware download exceeds the pinned size.')
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if received != SIZE or digest.hexdigest() != SHA256:
            raise FirmwareError('Official firmware download failed size/SHA256 verification.')
        check()
        # Destination is backend-managed and did not exist when preparation began.
        if destination.exists():
            raise FirmwareError('Firmware cache path appeared during preparation; retry.')
        temporary.rename(destination)
        log('Official firmware ready: 2116288 bytes, SHA256 verified.')
        return destination
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary.exists():
            temporary.unlink()  # Only our own unfinished download is removed.


def boot_region(data):
    if len(data) < 37:
        raise FirmwareError('Flash image is too short for a K210 boot header.')
    length = struct.unpack('<I', data[1:5])[0]
    if not 0 < length <= FLASH_BYTES - 37 or length + 37 > len(data):
        raise FirmwareError('Original firmware boot length is outside the complete flash image.')
    # Verified MaixPy DIO images use 0x02; older images also use 0x00.
    # Preserve the actual flag in restore packages instead of inventing it.
    if data[0] not in (0x00, 0x02):
        raise FirmwareError('Unsupported original boot flag; backup retained, flashing blocked.')
    header_digest = hashlib.sha256(data[:5 + length]).digest()
    if header_digest != data[5 + length:37 + length]:
        raise FirmwareError('Original firmware header SHA256 verification failed; flashing blocked.')
    region = data[:length + 37]
    return {'flag': data[0], 'firmwareBytes': length,
            'firmwareSha256': hashlib.sha256(data[5:5 + length]).hexdigest(),
            'bootBytes': len(region), 'bootSha256': hashlib.sha256(region).hexdigest()}, region


def make_restore_packages(directory, full_path, boot_data):
    directory = Path(directory)
    full_path = Path(full_path)
    if (full_path.is_symlink() or not full_path.is_file()
            or full_path.resolve() != directory.resolve() / 'full-flash.raw.bin'
            or full_path.stat().st_size != FLASH_BYTES):
        raise FirmwareError('Restore packages require the current complete raw flash image.')
    metadata, original_boot = boot_region(full_path.read_bytes())
    if boot_data != original_boot:
        raise FirmwareError('Boot restore bytes differ from the complete raw flash image.')
    boot_path = directory / 'original-boot-region.raw.bin'
    with private_file(boot_path) as stream:
        stream.write(boot_data)
        stream.flush()
        os.fsync(stream.fileno())
    for target, source in (('boot-restore.kfpkg', boot_path),
                           ('full-flash-restore.kfpkg', full_path)):
        path = directory / target
        with private_file(path) as file:
            with zipfile.ZipFile(file, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.write(source, source.name)
                # kflash 1.1.6 rewrites '"address": ...,' with a greedy
                # legacy regex. Compact JSON avoids that rewrite while keeping
                # the address a valid string for its int(address, 0) call.
                archive.writestr('flash-list.json', json.dumps({'version': '0.1.0', 'files': [
                    {'address': '0x00000000', 'bin': source.name, 'sha256Prefix': False}]},
                    separators=(',', ':')))
            file.flush()
            os.fsync(file.fileno())
    validate_restore_packages(directory, dict(metadata, flashBytes=FLASH_BYTES,
                                             flashSha256=file_sha256(full_path)))
    return boot_path


def _restore_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise FirmwareError('Restore package JSON contains a duplicate key.')
        result[key] = value
    return result


def _validate_restore_package(path, raw_name, expected_size, expected_sha, check):
    """Validate the two-entry KFPKG we generate; never extract a ZIP member.

    Fixed kflash 1.1.6 uses flash-list.json's address/bin/sha256Prefix fields.
    Its extractall path is intentionally not reused here: validate the exact
    generated container, CRC and bounded payload bytes before any loader call.
    """
    try:
        if path.is_symlink() or not path.is_file():
            raise FirmwareError('A required restore package is missing or is a symbolic link.')
        archive_size = path.stat().st_size
        if not 22 <= archive_size <= expected_size + 69632:
            raise FirmwareError('Restore package container exceeds its bounded size.')
        with open(path, 'rb') as raw:
            raw.seek(-22, os.SEEK_END)
            end = struct.unpack('<4s4H2IH', raw.read(22))
            signature, disk, central_disk, disk_count, count, central_size, central_offset, comment_size = end
            if (signature != b'PK\x05\x06' or disk or central_disk
                    or disk_count != 2 or count != 2 or comment_size
                    or central_size > 1024
                    or central_offset + central_size != archive_size - 22):
                raise FirmwareError('Restore package has an unexpected ZIP directory or trailing data.')
            with zipfile.ZipFile(raw) as archive:
                members = archive.infolist()
                if (len(members) != 2 or len({m.filename for m in members}) != 2
                        or {m.filename for m in members} != {raw_name, 'flash-list.json'}
                        or archive.comment):
                    raise FirmwareError('Restore package must contain exactly its known raw image and flash-list.json.')
                offset = 0
                for info in sorted(members, key=lambda value: value.header_offset):
                    name = info.filename.encode('ascii')
                    if (info.header_offset != offset or info.flag_bits or info.extra or info.comment
                            or info.volume or stat.S_ISLNK(info.external_attr >> 16)
                            or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                        raise FirmwareError('Restore package contains an unsupported ZIP entry or layout.')
                    raw.seek(offset)
                    header = struct.unpack('<4s5H3I2H', raw.read(30))
                    if (header[0] != b'PK\x03\x04' or header[2] != info.flag_bits
                            or header[3] != info.compress_type or header[6] != info.CRC
                            or header[7] != info.compress_size or header[8] != info.file_size
                            or header[9] != len(name) or header[10] or raw.read(len(name)) != name):
                        raise FirmwareError('Restore package local ZIP header does not match its directory.')
                    offset += 30 + len(name) + info.compress_size
                if (offset != central_offset
                        or central_size != sum(46 + len(m.filename.encode('ascii')) for m in members)):
                    raise FirmwareError('Restore package contains unreferenced or extra ZIP data.')
                listing = archive.getinfo('flash-list.json')
                if not 0 < listing.file_size <= 4096:
                    raise FirmwareError('Restore package flash-list.json exceeds its bound.')
                with archive.open(listing) as stream:
                    data = stream.read(4097)  # Reading to EOF also checks its ZIP CRC.
                plan = json.loads(data.decode('utf-8'), object_pairs_hook=_restore_json_object)
                if (type(plan) is not dict or set(plan) != {'version', 'files'}
                        or plan['version'] != '0.1.0' or type(plan['files']) is not list
                        or len(plan['files']) != 1 or type(plan['files'][0]) is not dict):
                    raise FirmwareError('Restore package flash-list.json has an unexpected schema.')
                entry = plan['files'][0]
                if (set(entry) != {'address', 'bin', 'sha256Prefix'}
                        or entry['address'] != '0x00000000' or entry['bin'] != raw_name
                        or entry['sha256Prefix'] is not False):
                    raise FirmwareError('Restore package must restore the known raw image at address zero without a new prefix.')
                if data != json.dumps(plan, separators=(',', ':')).encode('utf-8'):
                    raise FirmwareError('Restore package JSON is not the reviewed kflash-compatible compact format.')
                payload = archive.getinfo(raw_name)
                if payload.file_size != expected_size:
                    raise FirmwareError('Restore package expanded image length differs from its current raw image.')
                digest, received = hashlib.sha256(), 0
                with archive.open(payload) as stream:
                    while True:
                        check()
                        chunk = stream.read(65536)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > expected_size:
                            raise FirmwareError('Restore package expanded past its fixed raw image bound.')
                        digest.update(chunk)
                if received != expected_size or digest.hexdigest() != expected_sha:
                    raise FirmwareError('Restore package payload SHA256 differs from the current raw image.')
    except (OSError, zipfile.BadZipFile, UnicodeError, ValueError, RuntimeError,
            struct.error, zlib.error) as exc:
        raise FirmwareError('Restore package is unreadable or failed ZIP/JSON/CRC validation.') from exc


def validate_restore_packages(directory, manifest, check=lambda: None):
    """Bind both recoverable KFPKG payloads to the current raw files/manifest."""
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        raise FirmwareError('Restore package directory is missing or is a symbolic link.')
    for package, raw_name, size_key, hash_key in (
            ('boot-restore.kfpkg', 'original-boot-region.raw.bin', 'bootBytes', 'bootSha256'),
            ('full-flash-restore.kfpkg', 'full-flash.raw.bin', 'flashBytes', 'flashSha256')):
        size, digest = manifest.get(size_key), manifest.get(hash_key)
        source = directory / raw_name
        if (type(size) is not int or not 37 <= size <= FLASH_BYTES
                or (size_key == 'flashBytes' and size != FLASH_BYTES)
                or not isinstance(digest, str) or len(digest) != 64
                or any(c not in '0123456789abcdef' for c in digest)
                or source.is_symlink() or not source.is_file() or source.stat().st_size != size
                or file_sha256(source) != digest):
            raise FirmwareError('Current raw recovery image does not match its restore manifest.')
        _validate_restore_package(directory / package, raw_name, size, digest, check)


def eligible_file(path):
    # Every regular file is copied opaquely to the private local backup.
    # Contents are never decoded, logged, inspected, or sent off this computer.
    return True, None


def ensure_space(directory, user_bytes):
    if user_bytes > MAX_USER_TOTAL:
        raise FirmwareError('Standalone program/model backup exceeds 256 MiB; flashing is blocked.')
    required = FLASH_BYTES * 3 + user_bytes + 16 * 1024 * 1024
    if shutil.disk_usage(directory).free < required:
        raise FirmwareError('Insufficient local disk space for a complete verified backup; flashing is blocked.')


def validate_backup(directory, manifest, progress=lambda completed, total: None):
    """Revalidate every local recovery byte before permitting ISP entry."""
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        raise FirmwareError('Verified backup directory is missing or is a symbolic link.')
    root = directory.resolve()
    full_path = root / 'full-flash.raw.bin'
    if (full_path.is_symlink() or not full_path.is_file()
            or full_path.stat().st_size != FLASH_BYTES
            or manifest.get('flashBytes') != FLASH_BYTES
            or file_sha256(full_path) != manifest.get('flashSha256')):
        raise FirmwareError('Complete local flash recovery image is missing, changed, or unverified.')
    metadata, _ = boot_region(full_path.read_bytes())
    if metadata['bootSha256'] != manifest.get('bootSha256'):
        raise FirmwareError('Original boot recovery image changed; flashing is blocked.')
    entries = [entry for entry in manifest.get('files', []) if entry.get('status') == 'verified']
    if any(entry.get('status') not in ('verified', 'directory') for entry in manifest.get('files', [])):
        raise FirmwareError('Backup manifest contains incomplete file copies; flashing is blocked.')
    progress(0, len(entries))
    for index, entry in enumerate(entries):
        remote = entry.get('path', '')
        relative = Path(entry.get('local', ''))
        expected = Path('files') / remote.lstrip('/')
        if (not remote.startswith('/') or '..' in remote.split('/') or '\\' in remote
                or relative.is_absolute() or '..' in relative.parts or relative != expected):
            raise FirmwareError('Backup file path is outside its controlled recovery directory.')
        local = root
        for part in relative.parts:
            local = local / part
            if local.is_symlink():
                raise FirmwareError('A local recovery file or parent directory is a symbolic link.')
        if os.path.commonpath((str(root), str(local.resolve()))) != str(root):
            raise FirmwareError('Recovery file escaped its backup directory.')
        if (not local.is_file() or local.stat().st_size != entry.get('size')
                or file_sha256(local) != entry.get('sha256')):
            raise FirmwareError('A standalone local recovery file is missing or changed: ' + remote)
        progress(index + 1, len(entries))
    validate_restore_packages(root, manifest, check=lambda: progress(len(entries), len(entries)))
    return full_path, metadata


def dump_script(size, remote_path=None, offset=0):
    """Read a bounded range; transfer offsets remain relative to this range."""
    if type(size) is not int or type(offset) is not int or size < 0 or offset < 0:
        raise FirmwareError('Snapshot offset and size must be nonnegative integers.')
    is_file = remote_path is not None
    if is_file and (not isinstance(remote_path, str) or not remote_path or '\x00' in remote_path):
        raise FirmwareError('Snapshot file path must be a nonempty string without NUL.')
    limit = MAX_USER_FILE if is_file else FLASH_BYTES
    if offset > limit or size > limit - offset:
        raise FirmwareError('Snapshot range exceeds its fixed Flash or user-file bound.')
    source = ('_nodu_backup_file.read(min(3072,%d-_nodu_backup_offset))' % size if is_file else
              'utils.flash_read(%d+_nodu_backup_offset,min(3072,%d-_nodu_backup_offset))' % (offset, size))
    lines = ['import ubinascii, uhashlib', 'from Maix import utils',
             '_nodu_backup_hash=uhashlib.sha256()', '_nodu_backup_offset=0']
    if is_file:
        lines.append('_nodu_backup_file=open(%r,"rb")' % remote_path)
    lines.append('try:')
    if is_file:
        lines.append(' _nodu_backup_file.seek(%d)' % offset)
    lines += [' while _nodu_backup_offset<%d:' % size,
              '  _nodu_backup_chunk=' + source,
              "  if not _nodu_backup_chunk: raise Exception('Unexpected backup EOF')",
              '  _nodu_backup_hash.update(_nodu_backup_chunk)',
              '  if _nodu_backup_chunk==_nodu_backup_chunk[:1]*len(_nodu_backup_chunk):',
              '   print("NODU_FILL %08x:%02x:%d"%(_nodu_backup_offset,_nodu_backup_chunk[0],len(_nodu_backup_chunk)))',
              '  else:',
              '   print("NODU_DATA %08x:"%_nodu_backup_offset+ubinascii.b2a_base64(_nodu_backup_chunk).decode().strip())',
              '  _nodu_backup_offset+=len(_nodu_backup_chunk)',
              ' print("NODU_SHA256 "+ubinascii.hexlify(_nodu_backup_hash.digest()).decode())',
              'finally:']
    lines.append(' _nodu_backup_file.close()' if is_file else ' pass')
    return '\n'.join(lines)


class BackupReceiver:
    """Strict offset/size/hash verifier for a controlled raw-REPL dump."""
    def __init__(self, destination, size, progress=lambda received, total: None):
        self.destination = Path(destination)
        self.size = size
        self.progress = progress
        self.received = 0
        self.digest = hashlib.sha256()
        self.remote_digest = None
        self.stream = private_file(destination)

    def line(self, line):
        if len(line) > 4200:
            raise FirmwareError('Backup line exceeds its bounded chunk size.')
        if line.startswith(b'NODU_SHA256 '):
            try:
                value = line[12:].decode('ascii')
            except UnicodeDecodeError as exc:
                raise FirmwareError('Invalid device SHA256 response encoding.') from exc
            if self.remote_digest is not None or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
                raise FirmwareError('Invalid or duplicate device SHA256 response.')
            self.remote_digest = value
            return
        if line.startswith(b'NODU_FILL '):
            try:
                parts = line[10:].split(b':')
                if (len(parts) != 3 or len(parts[0]) != 8 or len(parts[1]) != 2
                        or not 1 <= len(parts[2]) <= 4
                        or any(c not in b'0123456789abcdef' for c in parts[0] + parts[1])
                        or any(c not in b'0123456789' for c in parts[2])):
                    raise ValueError('Invalid fill fields')
                offset, value, count = int(parts[0], 16), int(parts[1], 16), int(parts[2])
                if count != min(CHUNK_BYTES, self.size - self.received) or count <= 0:
                    raise ValueError('Invalid fill length')
                data = bytes((value,)) * count
            except ValueError as exc:
                raise FirmwareError('Malformed bounded fill chunk.') from exc
            self._chunk(offset, data)
            return
        if not line.startswith(b'NODU_DATA ') or len(line) < 19 or line[18:19] != b':':
            raise FirmwareError('Unexpected backup response; raw data was not logged.')
        if self.remote_digest is not None:
            raise FirmwareError('Backup data arrived after the final hash.')
        try:
            offset = int(line[10:18], 16)
            data = base64.b64decode(line[19:], validate=True)
        except (ValueError, UnicodeError) as exc:
            raise FirmwareError('Malformed backup chunk.') from exc
        self._chunk(offset, data)

    def _chunk(self, offset, data):
        if self.remote_digest is not None:
            raise FirmwareError('Backup data arrived after the final hash.')
        expected = min(CHUNK_BYTES, self.size - self.received)
        if offset != self.received or len(data) != expected or expected <= 0:
            raise FirmwareError('Backup offset/chunk size mismatch; flashing is blocked.')
        self.stream.write(data)
        self.digest.update(data)
        self.received += len(data)
        self.progress(self.received, self.size)

    def finish(self):
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        digest = self.digest.hexdigest()
        if self.received != self.size or digest != self.remote_digest:
            raise FirmwareError('Complete backup size/device SHA256 verification failed.')
        if file_sha256(self.destination) != digest:
            raise FirmwareError('Local backup read-back SHA256 verification failed.')
        return digest

    def close(self):
        self.stream.close()


def flash_image(path, port, log, report_progress=lambda stage, completed, total: None):
    validate_image(path)
    try:
        from kflash import KFlash
    except ImportError as exc:
        raise FirmwareError('Install kflash==1.1.6 in the selected Python environment before flashing.') from exc
    if importlib.metadata.version('kflash') != '1.1.6':
        raise FirmwareError('Firmware writing requires the reviewed kflash==1.1.6 version.')
    previous = getattr(KFlash, 'print_callback', None)
    last_progress = {}

    def printer(*parts, **kwargs):
        text = ' '.join(str(part) for part in parts).strip()
        if text:
            log(text)

    def progress(kind, iteration, total, suffix):
        percent = int(iteration * 100 / total) if total else 0
        if last_progress.get(kind) != percent:
            last_progress[kind] = percent
            report_progress('flash-' + str(kind), iteration, total)
            log('Firmware %s %d%% (%s/%s)' % (kind, percent, iteration, total))

    KFlash.print_callback = printer
    try:
        # kflash 1.1.6's Python API sets erase=False. A normal .bin uses
        # offset=0 and sha256Prefix=True. Automatic board detection matches
        # the hardware's previously successful command; no invented -B flag.
        KFlash().process(terminal=False, dev=port, baudrate=1500000, board=None,
                         sram=False, file=str(path), callback=progress,
                         noansi=True, io_mode='dio')
    except SystemExit as exc:
        raise FirmwareError('kflash exited unexpectedly: %s' % exc) from None
    finally:
        KFlash.print_callback = previous
