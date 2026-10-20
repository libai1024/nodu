#!/usr/bin/env python3
"""Independent numerical check of the Rust probe against pinned C data/Qt rules.

Usage: cargo run -q -p nodu-imaging --example reference_probe | python3 ../../tools/refs/check-imaging.py
Run Cargo in desktop/native; use an absolute script path if convenient.
"""
import json
import math
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT.parent / "nodu-refs/openmv-qt-creator"
REV = "af179e44cddf396a5ab618792d71e9de5cc67032"


def table(name, filename):
    text = subprocess.check_output(
        ["git", "-C", str(SOURCE), "show", f"{REV}:src/plugins/openmv/histogram/{filename}"],
        text=True,
    )
    return [int(x) for x in re.findall(r"-?\d+", re.search(rf"{name}\[\d+\] = \{{(.*?)\}};", text, re.S)[1])]


def rounded(value):
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def expected_channel(name, samples, values):
    bins = [samples.count(value) for value in values]
    ordered = sorted(samples)
    n = len(ordered)
    mean = rounded(sum(ordered) / n)
    stats = {
        "mean": mean,
        "median": ordered[(n + 1) // 2 - 1],
        "mode": values[bins.index(max(bins))],
        "stdev": rounded(math.sqrt(sum((v - mean) ** 2 for v in ordered) / n)),
        "min": ordered[0],
        "max": ordered[-1],
        "lq": ordered[(n + 3) // 4 - 1],
        "uq": ordered[(3 * n + 3) // 4 - 1],
    }
    return {"name": name, "values": values, "bins": bins, "statistics": stats}


def main():
    actual = json.load(sys.stdin)
    rb5, g6 = table("rb825_table", "rgb2rgb_tab.c"), table("g826_table", "rgb2rgb_tab.c")
    rb8, g8 = table("rb528_table", "rgb2rgb_tab.c"), table("g628_table", "rgb2rgb_tab.c")
    lab, yuv = table("lab_table", "lab_tab.c"), table("yuv_table", "yuv_tab.c")
    rgb_samples, lab_samples, yuv_samples = [], [], []
    for i in range(3, 254):
        r, g, b = rb5[i % 256], g6[(i * 37) % 256], rb5[255 - i % 256]
        # Construct conventional RGB565 then byte-swap, independently of Rust.
        pixel = (r << 11) | (g << 5) | b
        index = ((pixel & 255) << 8) | (pixel >> 8)
        rgb_samples.append((rb8[r], g8[g], rb8[b]))
        lab_samples.append(lab[index * 3:index * 3 + 3])
        color = yuv[index * 3:index * 3 + 3]
        yuv_samples.append((color[0] + 128, color[1], color[2]))
    specs = [
        ("RGB", rgb_samples, [rb8, g8, rb8]),
        ("Y", yuv_samples, [list(range(256))]),
        ("LAB", lab_samples, [list(range(101)), list(range(-128, 128)), list(range(-128, 128))]),
        ("YUV", yuv_samples, [list(range(256)), list(range(-128, 128)), list(range(-128, 128))]),
    ]
    expected = [
        {"count": 251, "channels": [
            expected_channel(name, [p[c] for p in samples], values[c])
            for c, name in enumerate(names)
        ]}
        for names, samples, values in specs
    ]
    if actual != expected:
        raise AssertionError("Rust histogram differs from the pinned reference calculation")
    print("4 spaces / 10 channels: all bins, quantization and 8 statistics match the pinned reference.")


if __name__ == "__main__":
    main()
