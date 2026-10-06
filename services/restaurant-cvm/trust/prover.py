"""Prover: build a valid LSAG trust-ring proof for an order, from a member key.

Used by the E2E harness (and by tests) to construct the proof the customer
submits. The prover holds a member private key and draws a ring of member public
keys from the pinned set — including its own — then LSAG-signs the order-bound
message. The verifier (``gate.py``) later confirms the ring is a subset of the
pinned set and the signature verifies over the same message it rebuilds from its
OWN copy of the order.
"""
from __future__ import annotations

import hashlib
import time

try:
    from .curve import base_mul, point_from_bytes, point_mul, point_to_bytes, scalar_from_bytes
    from .lsag import sign
    from .trustset import set_content_hash
except ImportError:  # direct / script import path
    from curve import base_mul, point_from_bytes, point_mul, point_to_bytes, scalar_from_bytes  # type: ignore
    from lsag import sign  # type: ignore
    from trustset import set_content_hash  # type: ignore

_MESSAGE_DOMAIN = b"restaurant-cvm/order/v1"

# Canonical field order for the bound message. Both prover and verifier build
# ``message_fields`` in this order, then hash identically — a change here breaks
# every proof, which is the point.
_FIELD_ORDER = [
    "order_id",
    "total_sats",
    "verifier_id",
    "set_id",
    "set_hash",
    "expiry",
    "key_image",
]


def key_image_for(secret_hex: str, public_key_hex: str) -> bytes:
    """I = x_s * H(P_s) — deterministic per key, the LSAG link."""
    x_s = scalar_from_bytes(bytes.fromhex(secret_hex))
    p_s = bytes.fromhex(public_key_hex)
    h = point_from_bytes(p_s)
    # H(P_s) via the same hash-to-curve the signer uses is computed inside sign();
    # here we reproduce it directly so the prover can report the image up front.
    from .lsag import hash_to_curve  # local import keeps this helper opt-in
    hp = hash_to_curve(p_s)
    return point_to_bytes(point_mul(point_from_bytes(hp), x_s))


def bound_message(message_fields: dict) -> bytes:
    """Canonical bound message: sha256(domain || length-prefixed fields)."""
    parts = [_MESSAGE_DOMAIN]
    for f in _FIELD_ORDER:
        v = str(message_fields[f]).encode("utf-8")
        parts.append(len(v).to_bytes(4, "big") + v)
    return hashlib.sha256(b"".join(parts)).digest()


def build_message_fields(*, expected_order: dict, policy: dict, set_doc: dict,
                         set_hash: str, expiry: int, key_image_hex: str) -> dict:
    """The exact field dict both sides commit to (stable key order)."""
    total_sats = expected_order.get("total_sats", expected_order.get("amount"))
    return {
        "order_id": str(expected_order["order_id"]),
        "total_sats": str(int(total_sats)),
        "verifier_id": str(policy["verifier_id"]),
        "set_id": str(set_doc["set_id"]),
        "set_hash": set_hash,
        "expiry": int(expiry),
        "key_image": key_image_hex,
    }


def build_proof(*, member_secret_hex: str, member_public_key_hex: str,
                ring_hex: list, set_doc: dict, policy: dict,
                expected_order: dict, created_at: int | None = None,
                expiry: int | None = None) -> dict:
    """Build a valid proof dict from a member key (used by the E2E harness).

    ``ring_hex`` is the ring of member public keys (hex) the prover draws; it
    MUST include ``member_public_key_hex`` and every key MUST be in the set.
    """
    expiry = int(expiry) if expiry is not None else int(time.time()) + int(policy.get("expiry_s", 3600))
    created_at = int(created_at) if created_at is not None else int(time.time())

    if member_public_key_hex not in ring_hex:
        raise ValueError("ring must include the signer's own public key")
    if len(set(ring_hex)) != len(ring_hex):
        raise ValueError("ring must not contain duplicate keys")

    set_hash = set_content_hash(set_doc)
    ring = [bytes.fromhex(pk) for pk in ring_hex]
    signer_index = ring_hex.index(member_public_key_hex)

    key_image = key_image_for(member_secret_hex, member_public_key_hex)
    key_image_hex = key_image.hex()

    message_fields = build_message_fields(
        expected_order=expected_order,
        policy=policy,
        set_doc=set_doc,
        set_hash=set_hash,
        expiry=expiry,
        key_image_hex=key_image_hex,
    )
    message = bound_message(message_fields)

    secret = bytes.fromhex(member_secret_hex)
    sig = sign(message, ring, signer_index, secret)

    return {
        "c_0": sig.c0.hex(),
        "s": [r.hex() for r in sig.responses],
        "ring": [pk.hex() for pk in ring],
        "key_image": key_image_hex,
        "set_id": set_doc["set_id"],
        "set_hash": set_hash,
        "created_at": created_at,
        "expiry": expiry,
        "message_fields": message_fields,
    }
