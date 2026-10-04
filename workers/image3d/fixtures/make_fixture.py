# SPDX-License-Identifier: CC0-1.0
"""Deterministic, owned transparent sphere fixture; writes a new PNG only."""
import argparse
import math
from pathlib import Path
import struct
import zlib


def chunk(kind, data):
    payload = kind + data
    return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xffffffff)


def create(path):
    side = 256
    rows = bytearray()
    light = (-0.45, -0.55, 0.7)
    norm = math.sqrt(sum(v * v for v in light))
    light = tuple(v / norm for v in light)
    for y in range(side):
        rows.append(0)
        for x in range(side):
            nx, ny = (x + 0.5 - 128) / 88, (y + 0.5 - 128) / 88
            r2 = nx * nx + ny * ny
            if r2 >= 1:
                rows.extend((0, 0, 0, 0))
                continue
            nz = math.sqrt(1 - r2)
            lambert = max(0, nx * light[0] + ny * light[1] + nz * light[2])
            highlight = max(0, nx * -0.32 + ny * -0.4 + nz * 0.86) ** 32
            shade = 0.32 + 0.68 * lambert
            color = [int(min(255, c * shade + highlight * 48)) for c in (55, 155, 235)]
            rows.extend((*color, 255))
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    create(parser.parse_args().output)
