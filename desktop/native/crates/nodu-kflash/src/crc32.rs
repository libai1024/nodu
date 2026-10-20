// SPDX-License-Identifier: MIT
// IEEE CRC-32 (poly 0xEDB88320 reflected, init/xorout 0xFFFFFFFF), identical
// to Python `binascii.crc32` / zlib.crc32 used by nodu_flash_protocol.py,
// nodu_firmware.py (ZIP member CRCs) and kflash.py packet checksums.

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

static TABLE: [u32; 256] = build_table();

/// `binascii.crc32(data) & 0xFFFFFFFF`.
#[must_use]
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc = TABLE[((crc ^ u32::from(byte)) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vectors() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        // zlib.crc32(b"\x00" * 8)
        assert_eq!(crc32(b"\x00".repeat(8).as_slice()), 0x6522_DF69);
        // binascii.crc32(b"The quick brown fox jumps over the lazy dog")
        assert_eq!(
            crc32(b"The quick brown fox jumps over the lazy dog"),
            0x414F_A339
        );
    }
}
