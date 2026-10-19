# SPDX-License-Identifier: MIT
# Current-session content verification after a rejected RAM identity response.
# Read-only: rb file handles, directory stats and utils.flash_read only.
# A matching prefix remains unverified as physical capacity or full coverage.
def _nodu_postcheck_fifth():
    import os, time, uhashlib, ubinascii, ujson
    from Maix import utils
    expected_files = [('/flash/config.json', 766, 'c1c9542727d1331a14153592ede6ec681a6e8a9f8e55fd4051858106340d7799'), ('/flash/demo_cam.py', 1421, '8e26ca312643e6d36b98e535a35e33dd20c8d6c05c830832bdec4ee4a234c0e3'), ('/flash/demo_green.py', 1612, 'ed9f0a4059d51ec52f8bdd14e12fa8b9794941e66fb21f501228cd3981b4d78e'), ('/flash/demo_lcd.py', 920, '970c8c9c7703dfcb0d0696c2da0552ea9d723a1af39e10e9841c195ff6cc30a1'), ('/flash/demo_qr.py', 1704, 'cb7bde40caef80df4a455b5469ff35a0f6e855882c7cde6e649850ec9607dd2d'), ('/flash/demo_test.py', 2581, '0c4581b2257c278a2871724e32b11c553a9f9e0c12c15b9923279eed6e03a214'), ('/flash/freq.conf', 16, 'e9608cb36f208d509ce910f02c64feee137af6a8b9b68ed99199a143e7cbf2ab'), ('/flash/gc2145_board.py', 7338, 'aa99ea97d1fa355483fa4d50cabcaaacbc8694a1e0f384785fad32f9adf8f9dd'), ('/flash/main.py', 516, '6b9ee4426fee24b0265dd24222735df93552b1b5de52bf7b83e8c630f3ee0290'), ('/flash/nodu-acceptance-1792345884045.txt', 1579, '5ce8c37a770ac1a1c5b74b64e49aa5c6d87d146eeae616eeacadd16f62329d27'), ('/flash/nodu-ui-roundtrip-20261019.bin', 4124, 'f019cbe2e09ff7d9fa2f4f4cfedb129bbd67cf1a26c8dd870dbeea3eb1571002'), ('/sd/System Volume Information/IndexerVolumeGuid', 76, '421c4ad04a42f5e8ff4924217599060300ea07641fd77fc8dfee218a32ad9d6d'), ('/sd/System Volume Information/WPSettings.dat', 12, 'e2419175509a4a7f046e75c382ba701cf1fd77eb5ba77960a327dcd9e955ac68'), ('/sd/maixpy_demos/01_lcd.py', 920, '970c8c9c7703dfcb0d0696c2da0552ea9d723a1af39e10e9841c195ff6cc30a1'), ('/sd/maixpy_demos/02_camera.py', 1421, '8e26ca312643e6d36b98e535a35e33dd20c8d6c05c830832bdec4ee4a234c0e3'), ('/sd/maixpy_demos/03_green_blobs.py', 1612, 'ed9f0a4059d51ec52f8bdd14e12fa8b9794941e66fb21f501228cd3981b4d78e'), ('/sd/maixpy_demos/04_qrcode.py', 1704, 'cb7bde40caef80df4a455b5469ff35a0f6e855882c7cde6e649850ec9607dd2d'), ('/sd/maixpy_demos/05_vision_selftest.py', 2581, '0c4581b2257c278a2871724e32b11c553a9f9e0c12c15b9923279eed6e03a214'), ('/sd/canmv-full-backup-20261018-224235.bin', 16777216, '9e4a4658aaa3ff33718583102d24dddb37f70e259273c97d50ae79bc941663a6'), ('/sd/main.py', 516, '6b9ee4426fee24b0265dd24222735df93552b1b5de52bf7b83e8c630f3ee0290'), ('/sd/maixpy_demo_camera.jpg', 3665, 'ac99404797df2023d6a899be53960ecb056a72fd2d7cf2839c21638b7b09159a')]
    expected_inventory = [('/flash/config.json', False, 766), ('/flash/demo_cam.py', False, 1421), ('/flash/demo_green.py', False, 1612), ('/flash/demo_lcd.py', False, 920), ('/flash/demo_qr.py', False, 1704), ('/flash/demo_test.py', False, 2581), ('/flash/freq.conf', False, 16), ('/flash/gc2145_board.py', False, 7338), ('/flash/main.py', False, 516), ('/flash/nodu-acceptance-1792345884045.txt', False, 1579), ('/flash/nodu-ui-roundtrip-20261019.bin', False, 4124), ('/sd/System Volume Information', True, 0), ('/sd/System Volume Information/IndexerVolumeGuid', False, 76), ('/sd/System Volume Information/WPSettings.dat', False, 12), ('/sd/canmv-full-backup-20261018-224235.bin', False, 16777216), ('/sd/main.py', False, 516), ('/sd/maixpy_demo_camera.jpg', False, 3665), ('/sd/maixpy_demos', True, 0), ('/sd/maixpy_demos/01_lcd.py', False, 920), ('/sd/maixpy_demos/02_camera.py', False, 1421), ('/sd/maixpy_demos/03_green_blobs.py', False, 1612), ('/sd/maixpy_demos/04_qrcode.py', False, 1704), ('/sd/maixpy_demos/05_vision_selftest.py', False, 2581)]
    prefix_size = 16777216
    boot_size = 2116325
    expected_prefix = 'c2945a0e2a3e1f26a2e31ed3c55202d88a0c07b8d010e392a78818bbc5b53d11'
    expected_boot = 'bd55469971151a2df1ae4bc262dce1305bfcafa53acb5fcd1583ab585a5f1014'
    started = time.ticks_ms()
    def guard():
        if time.ticks_diff(time.ticks_ms(), started) > 180000:
            raise RuntimeError('postcheck time bound exceeded')
    def inventory():
        result = []
        def visit(path, depth):
            guard()
            if depth > 32 or len(result) > 5000:
                raise RuntimeError('inventory bound exceeded')
            for name in os.listdir(path):
                guard()
                if '/' in name or name in ('.', '..'):
                    continue
                child = path + '/' + name
                info = os.stat(child)
                directory = bool(info[0] & 0x4000)
                result.append((child, directory, info[6]))
                if directory:
                    visit(child, depth + 1)
        for mount in ('/flash', '/sd'):
            try:
                os.stat(mount)
            except OSError as error:
                if error.args[0] == 2:
                    continue
                raise
            visit(mount, 0)
        return sorted(result)
    before = inventory() == expected_inventory
    matched = 0
    failed = []
    for index, item in enumerate(expected_files):
        path, expected_size, expected_digest = item
        guard()
        try:
            initial = os.stat(path)
            if initial[0] & 0x4000 or initial[6] != expected_size:
                failed.append(index)
                continue
            digest = uhashlib.sha256()
            count = 0
            stream = open(path, 'rb')
            try:
                while count < expected_size:
                    guard()
                    chunk = stream.read(min(8192, expected_size - count))
                    if not chunk:
                        break
                    digest.update(chunk)
                    count += len(chunk)
                extra = stream.read(1)
            finally:
                stream.close()
            current = ubinascii.hexlify(digest.digest()).decode()
            if (count == expected_size and not extra and os.stat(path)[6] == expected_size
                    and current == expected_digest):
                matched += 1
            else:
                failed.append(index)
        except OSError:
            failed.append(index)
    prefix_hash = uhashlib.sha256()
    boot_hash = uhashlib.sha256()
    for offset in range(0, prefix_size, 8192):
        guard()
        length = min(8192, prefix_size - offset)
        chunk = utils.flash_read(offset, length)
        if len(chunk) != length:
            raise RuntimeError('prefix read length mismatch')
        prefix_hash.update(chunk)
        if offset < boot_size:
            boot_hash.update(chunk[:min(length, boot_size - offset)])
    prefix_digest = ubinascii.hexlify(prefix_hash.digest()).decode()
    boot_digest = ubinascii.hexlify(boot_hash.digest()).decode()
    after = inventory() == expected_inventory
    result = {'filesMatched': matched, 'filesExpected': len(expected_files),
              'failedFileIndices': failed, 'inventoryBefore': before, 'inventoryAfter': after,
              'prefixMatch': prefix_digest == expected_prefix, 'bootMatch': boot_digest == expected_boot,
              'capacityVerified': False, 'elapsedMs': time.ticks_diff(time.ticks_ms(), started)}
    result['allUnchanged'] = matched == len(expected_files) and before and after and result['prefixMatch'] and result['bootMatch']
    print('NODU_POSTCHECK_FIFTH ' + ujson.dumps(result))
    print('NODU_PREFIX_SHA256 ' + prefix_digest)
    print('NODU_BOOT_SHA256 ' + boot_digest)
_nodu_postcheck_fifth()
