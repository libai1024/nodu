import sys, json
sys.path.insert(0, '/Users/wangwei/Model/k210-studio/desktop/scope-extension/resources')
sys.path.insert(0, '/Users/wangwei/Model/k210-studio/tools/flash-probe/e7-diagnostic-candidate')
from pathlib import Path
import nodu_flash_probe as pm
import nodu_flash_protocol as protocol
import host_diagnostic

pm.STUB_PATH = Path('/Users/wangwei/Model/k210-studio/tools/flash-probe/e7-diagnostic-candidate/build/probe.bin')
pm.STUB_SHA256 = 'f9dbf480f1f2bca6e6fd8393306058093c377217afe2059c5874ac5f20b9d874'
pm.STUB_SIZE = 8792

orig = protocol.parse_jedec_response
def patched(frame):
    try:
        return orig(frame)
    except Exception:
        if len(frame) == 11 and frame[0] == 0xDE and frame[1] == 0xE7:
            d = host_diagnostic.parse_e7_diagnostic(frame)
            d['frameHex'] = frame.hex()
            return d
        raise
protocol.parse_jedec_response = patched

try:
    r = pm.probe('/dev/cu.usbserial-3120', nonce='0'*32, session='e7diag',
                 log=lambda t: print('LOG:', t, flush=True))
    r['verified'] = 'diagnostic-run (not a capacity proof)'
    print('RESULT', json.dumps(r, ensure_ascii=False))
except Exception as e:
    print('PROBE-ERROR:', e)
