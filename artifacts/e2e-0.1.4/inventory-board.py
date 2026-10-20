# Read-only inventory. Run in raw REPL after the UI releases the serial port.
import uos
import ujson
import uhashlib
import ubinascii

_inventory_errors = []


def _inventory_emit(record):
    print("NODU_INVENTORY:" + ujson.dumps(record))


def _inventory_walk(path, depth):
    if depth > 16:
        raise RuntimeError("Inventory nesting limit exceeded: " + path)
    info = uos.stat(path)
    if info[0] & 0x4000:
        _inventory_emit({"type": "directory", "path": path})
        for name in sorted(uos.listdir(path)):
            _inventory_walk(path + "/" + name, depth + 1)
    else:
        digest = uhashlib.sha256()
        count = 0
        with open(path, "rb") as source:
            while True:
                chunk = source.read(4096)
                if not chunk:
                    break
                digest.update(chunk)
                count += len(chunk)
        if count != info[6] or uos.stat(path)[6] != count:
            raise RuntimeError("File size changed during inventory: " + path)
        _inventory_emit({
            "type": "file", "path": path, "size": count,
            "sha256": ubinascii.hexlify(digest.digest()).decode()
        })


for _inventory_root in ("/flash", "/sd"):
    try:
        _inventory_walk(_inventory_root, 0)
    except Exception as _inventory_error:
        _inventory_errors.append({
            "path": _inventory_root, "error": repr(_inventory_error)
        })
_inventory_emit({"type": "complete", "errors": _inventory_errors})
