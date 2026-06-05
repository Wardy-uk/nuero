#!/usr/bin/env python3
# Verify an Apple Watch IRK by resolving live Resolvable Private Addresses (RPAs).
#
# A BLE RPA is 48 bits: the top 24 = prand (MSB's top two bits = 0b01), the bottom
# 24 = hash, where hash = ah(IRK, prand). ah(k,r) = AES-128-ECB(k, 0^13 || r)[-3:]
# (Bluetooth Core Spec). If our IRK reproduces a present device's hash, the key is
# proven correct. We brute-force IRK byte order (BlueZ-stored vs reversed) and prand
# orientation so we also learn which form Home Assistant will want.
#
# AES via the openssl CLI (always present) — no pip installs.

import subprocess
import sys

IRK_HEX = "2e0f010e4738175560d042fa99a1bf2d"  # from /var/lib/bluetooth .../info


def aes128_ecb(key16: bytes, data16: bytes) -> bytes:
    p = subprocess.run(
        ["openssl", "enc", "-aes-128-ecb", "-K", key16.hex(), "-nopad"],
        input=data16, capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode())
    return p.stdout[:16]


def ah(irk16: bytes, prand3: bytes) -> bytes:
    return aes128_ecb(irk16, bytes(13) + prand3)[13:16]


def addr_to_bytes(addr: str) -> bytes:
    # "AA:BB:CC:DD:EE:FF" -> b'\xAA\xBB\xCC\xDD\xEE\xFF' (MSB first as written)
    return bytes(int(x, 16) for x in addr.split(":"))


def is_rpa(addr_bytes: bytes) -> bool:
    # Resolvable: top two bits of the most-significant byte == 0b01
    return (addr_bytes[0] & 0xC0) == 0x40


def main():
    irk = bytes.fromhex(IRK_HEX)
    irk_forms = {"irk_as_stored": irk, "irk_reversed": irk[::-1]}

    addrs = [a.strip() for a in sys.argv[1:] if a.strip()]
    if not addrs:
        addrs = [l.strip() for l in sys.stdin if l.strip()]

    rpas = []
    for a in addrs:
        try:
            b = addr_to_bytes(a)
        except Exception:
            continue
        if len(b) == 6 and is_rpa(b):
            rpas.append((a, b))

    print(f"IRK under test: {IRK_HEX}")
    print(f"Candidate RPAs scanned: {len(rpas)}")
    if not rpas:
        print("RESULT: no resolvable private addresses captured to test against.")
        return

    hit = False
    for a, b in rpas:
        prand, h = b[0:3], b[3:6]
        for name, k in irk_forms.items():
            # try prand as-written and reversed, compare hash as-written and reversed
            for pr_label, pr in (("prand", prand), ("prand_rev", prand[::-1])):
                out = ah(k, pr)
                if out == h or out[::-1] == h:
                    print(f"  ✓ MATCH  addr={a}  via {name} + {pr_label}")
                    hit = True
    if hit:
        print("RESULT: IRK CONFIRMED — it resolves a live device address.")
    else:
        print("RESULT: no match among captured RPAs (key may be wrong, or the Watch's"
              " current RPA wasn't captured this scan).")


if __name__ == "__main__":
    main()
