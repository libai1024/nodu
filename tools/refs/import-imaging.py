#!/usr/bin/env python3
"""Import pinned numerical data without compiling the reference Qt application."""
import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "nodu-refs/openmv-qt-creator"
REVISION = "af179e44cddf396a5ab618792d71e9de5cc67032"
DEST = ROOT / "desktop/native/crates/nodu-imaging/data"
TABLES = {
    "lab_table": ("lab_tab.c", 196608, "77281d24e6b54e4631775bcdf31953d83bf9996bc69f8ae67b046a666506e48a"),
    "yuv_table": ("yuv_tab.c", 196608, "3934e95630e51d66299c5147b8ce1b1f04aef5bc5ffd9825ff64297293872a48"),
    "rb528_table": ("rgb2rgb_tab.c", 32, "719619b7c8834183f73d1aa239a35a2fa5d620ca4080db37cfba15ee85f423a6"),
    "g628_table": ("rgb2rgb_tab.c", 64, "c0fd7b9765d50e9490e66130bad2cf3c4dc1c8f49a6edfcb713e415049b5331e"),
    "rb825_table": ("rgb2rgb_tab.c", 256, "ce57accfbc497e1f53698defa95b322b866b674850b03b373bea658ccf3502cf"),
    "g826_table": ("rgb2rgb_tab.c", 256, "64ea6b7da77b8c4187efece59de6901c34f3842e2c1df361a72d077bc176e74f"),
}
TAGS = {
    "tag16h5": (30, 4, "257864968dd7e00b684a3044e309e9496c9d23fec70c9234526450da0a12151b"),
    "tag25h7": (242, 5, "4aae6b219e9fa685714d4934d36bd6c59df7d9d5d17b517d60c2617273306a2f"),
    "tag25h9": (35, 5, "5887bb2a3b300a9d19584786956c185e831a43c46fba566a232cc97e6926562b"),
    "tag36artoolkit": (512, 6, "cfb34ba8bbf88329c729eecc7fd29d845eb02c19fa3c57629cd3fdeddbe5fdb3"),
    "tag36h10": (2320, 6, "1c4aa851701b8af7e5466cc730db1bf4908f7ba0b48ea6e7aa5cb3ac7ca90495"),
    "tag36h11": (587, 6, "ffe5149e5800eb160cde85db3578d99f7585dadff54983b6c570eaa5b277b846"),
}


def reference(path):
    # Read the pinned Git object, not a possibly edited working-tree file.
    return subprocess.check_output(
        ["git", "-C", str(SOURCE), "show", f"{REVISION}:src/plugins/openmv/{path}"],
        text=True,
    )


def main():
    outputs = {}
    for name, (filename, length, digest) in TABLES.items():
        text = reference(f"histogram/{filename}")
        match = re.search(rf"const (?:u?int8_t) {name}\[{length}\] = \{{(.*?)\}};", text, re.S)
        if match is None:
            raise ValueError(f"Missing array {name}")
        values = [int(x) for x in re.findall(r"-?\d+", match[1])]
        if len(values) != length or any(not -128 <= x <= 255 for x in values):
            raise ValueError(f"Invalid array {name}")
        outputs[name] = (bytes(x & 255 for x in values), digest)
    for name, (count, dimension, digest) in TAGS.items():
        text = reference(f"tools/{name}.c")
        codes = re.findall(r"tf->codes\[(\d+)\] = (0x[0-9a-fA-F]+)UL;", text)
        if [int(i) for i, _ in codes] != list(range(count)):
            raise ValueError(f"Missing or reordered tag codes: {name}")
        for field, expected in [("ncodes", count), ("d", dimension), ("black_border", 1)]:
            if int(re.search(rf"tf->{field} = (\d+)", text)[1]) != expected:
                raise ValueError(f"Unexpected {name}.{field}")
        outputs[name] = (b"".join(int(code, 16).to_bytes(8, "little") for _, code in codes), digest)
    for name, (data, digest) in outputs.items():
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"Checksum mismatch: {name}")
    DEST.mkdir(parents=True, exist_ok=True)
    for name, (data, _) in outputs.items():
        (DEST / f"{name}.bin").write_bytes(data)
    print(f"Imported {len(outputs)} verified data arrays from {REVISION}")


if __name__ == "__main__":
    main()
