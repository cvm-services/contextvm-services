"""secp256k1 adapter for the trust ring — byte-in / byte-out.

Backend: ``coincurve`` (libsecp256k1 bindings). This module deliberately exposes
no backend types: everything is bytes, so the LSAG implementation is portable and
unit-testable without any host app. Byte-for-byte port of the fleet's tested
Electrum ``trust_vendor/curve.py`` (itself a port of the TypeScript LSAG).
"""
from __future__ import annotations

import hashlib
import os
from typing import Sequence

from coincurve import PublicKey

# secp256k1 group order n.
CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

_H2C_TAG = b"LSAG/H2C"
_HASH_TAG = b"LSAG/v1"


# ---------------------------------------------------------------------------
# scalars
# ---------------------------------------------------------------------------

def mod_n(x: int) -> int:
    return x % CURVE_ORDER


def scalar_from_bytes(b: bytes) -> int:
    return int.from_bytes(b, "big") % CURVE_ORDER


def scalar_to_bytes(s: int) -> bytes:
    return mod_n(s).to_bytes(32, "big")


def random_scalar() -> int:
    return scalar_from_bytes(os.urandom(32))


# ---------------------------------------------------------------------------
# points (33-byte compressed form on the wire)
# ---------------------------------------------------------------------------

def point_from_bytes(b: bytes) -> PublicKey:
    """Parse + validate a 33-byte compressed point. Raises ValueError."""
    return PublicKey(bytes(b))


def is_valid_point(b: bytes) -> bool:
    try:
        point_from_bytes(b)
        return True
    except Exception:
        return False


def point_to_bytes(point: PublicKey) -> bytes:
    return point.format(compressed=True)


def base_mul(k: int) -> PublicKey:
    """k*G."""
    return PublicKey.from_valid_secret(scalar_to_bytes(k))


def point_mul(point: PublicKey, k: int) -> PublicKey:
    """k*P."""
    return point.multiply(scalar_to_bytes(k))


def point_add(p: PublicKey, q: PublicKey) -> PublicKey:
    """P + Q (with an explicit doubling path)."""
    if point_to_bytes(p) == point_to_bytes(q):
        return point_mul(p, 2)
    return p.combine([q])


def xonly_to_point(x32: bytes, even_y: bool = True) -> PublicKey:
    """BIP340 x-only pubkey -> full point (even-y per BIP340 by default)."""
    if len(x32) != 32:
        raise ValueError(f"x-only key must be 32 bytes, got {len(x32)}")
    return point_from_bytes((b"\x02" if even_y else b"\x03") + x32)


# ---------------------------------------------------------------------------
# hashing
# ---------------------------------------------------------------------------

def _length_prefixed(item: bytes) -> bytes:
    return len(item).to_bytes(4, "big") + item


def hash_to_scalar(items: Sequence[bytes]) -> int:
    """H('LSAG/v1', item_0 ... item_k-1) mod n, each item length-prefixed.

    Byte-for-byte port of ``hashToScalar`` in the fleet's TypeScript LSAG.
    """
    h = hashlib.sha256()
    h.update(_HASH_TAG)
    for item in items:
        h.update(_length_prefixed(bytes(item)))
    return scalar_from_bytes(h.digest())


def hash_to_curve(data: bytes) -> bytes:
    """Deterministic hash-to-curve: try-and-increment, ~1/2 hit rate per step.

    Faithful port of ``hashToCurve``: the candidate x-coordinate is
    ``digest[1:32] || 0x00`` and the parity byte is ``digest[0] & 1`` — quirky
    but deterministic and identical on both sides. Do not "fix" it.
    """
    counter = 0
    while True:
        digest = hashlib.sha256(
            _H2C_TAG + data + counter.to_bytes(4, "big")
        ).digest()
        x = digest[1:32] + b"\x00"
        prefix = b"\x02" if (digest[0] & 0x01) == 0 else b"\x03"
        candidate = prefix + x
        if is_valid_point(candidate):
            return candidate
        counter += 1
