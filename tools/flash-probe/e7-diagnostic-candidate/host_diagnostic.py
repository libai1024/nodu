# SPDX-License-Identifier: MIT
"""Original, offline parser for the isolated E7 diagnostic candidate.

This module imports no active resource parser and has no serial or execution
entry point. The caller must supply an already decoded, raw protocol frame;
SLIP framing and escaping are outside this parser.

A valid CRC only checks frame integrity. These returned IDs are observed bytes,
not authenticated identities, capacity evidence, or an allowlist decision.
"""

from binascii import crc32

__all__ = ["parse_e7_diagnostic"]


def parse_e7_diagnostic(frame: bytes) -> dict:
    """Parse exactly DE E7 + JEDEC(3) + legacy90(2) + CRC32-LE(4).

    CRC32 covers the first seven bytes. Only an exact ``bytes`` object is
    accepted. Invalid types raise TypeError; invalid frames raise ValueError.
    Unknown, all-zero, and all-FF IDs remain unauthenticated diagnostic data.
    """
    if type(frame) is not bytes:
        raise TypeError("frame must be a bytes object")
    if len(frame) != 11:
        raise ValueError("E7 diagnostic frame must contain exactly 11 bytes")
    if frame[0] != 0xDE:
        raise ValueError("E7 diagnostic frame must have opcode DE")
    if frame[1] != 0xE7:
        raise ValueError("E7 diagnostic frame must have status E7")

    received_crc = int.from_bytes(frame[7:11], "little")
    if (crc32(frame[:7]) & 0xFFFFFFFF) != received_crc:
        raise ValueError("E7 diagnostic frame CRC32 mismatch")

    return {
        "authenticated": False,
        "capacityVerified": False,
        "jedecId": frame[2:5].hex(),
        "legacy90": frame[5:7].hex(),
    }
