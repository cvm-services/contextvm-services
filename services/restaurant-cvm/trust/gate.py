"""The verification gate — the ordered policy, with stable reason strings.

This is the money path. The verifier (the restaurant / S4a) holds the order and
the pinned set; a proof is accepted only when EVERY rule holds, in order, and the
FIRST failure is reported. The two rules that make the scheme sound:

  * ring SUBSET of the pinned set (never "contains a trusted key") — an attacker
    who builds ring = {own key, one scraped trusted key} must fail (the RED test);
  * the verifier rebuilds the bound message from ITS OWN order and requires
    field-by-field equality BEFORE the signature check — a valid signature that
    binds a different amount is refused with ``order-mismatch``.

The key-image seen-set runs LAST so a rejected proof never burns a key image.
"""
from __future__ import annotations

import json
import os
import time
from typing import Optional

try:
    from .lsag import LSAGSignature, verify as lsag_verify
    from .prover import bound_message
    from .trustset import check_freshness, set_content_hash
except ImportError:  # direct / script import path
    from lsag import LSAGSignature, verify as lsag_verify  # type: ignore
    from prover import bound_message  # type: ignore
    from trustset import check_freshness, set_content_hash  # type: ignore

# Stable reason strings (part of the interface — S4a and the UI depend on these).
R_MISSING = "missing-proof"
R_BAD_STRUCTURE = "bad-proof-structure"
R_NOT_IN_SET = "not-in-set"
R_DUPLICATE_KEYS = "duplicate-ring-keys"
R_RING_TOO_SMALL = "ring-too-small"
R_SET_HASH_MISMATCH = "set-hash-mismatch"
R_SET_STALE = "set-version-stale"
R_SET_FUTURE = "set-version-future"
R_EXPIRED = "proof-expired"
R_ORDER_MISMATCH = "order-mismatch"
R_BAD_SIGNATURE = "bad-signature"
R_ALREADY_PROVEN = "order-already-proven"

_REQUIRED_PROOF_FIELDS = (
    "c_0", "s", "ring", "key_image", "set_id", "set_hash",
    "created_at", "expiry", "message_fields",
)

_MESSAGE_FIELD_ORDER = (
    "order_id", "total_sats", "verifier_id", "set_id", "set_hash",
    "expiry", "key_image",
)


class OrderGate:
    """Stateful gate for one pinned set: fresh-version cache + per-order seen-set."""

    def __init__(self, set_doc: dict, policy: dict,
                 cached_published_at: Optional[str] = None):
        self.set_doc = set_doc
        self.policy = policy
        self.set_hash = set_content_hash(set_doc)
        self.set_id = set_doc["set_id"]
        # newest set version we have cached (monotonic acceptance)
        self.cached_published_at = cached_published_at or set_doc["published_at"]
        # key-image seen-set, scoped per order id
        self._seen: dict = {}

    def _seen_scope(self, order_id: str) -> str:
        return str(order_id)

    def verify(self, proof: Optional[dict], expected_order: dict,
               now: Optional[int] = None) -> tuple:
        return verify_order_proof_impl(
            proof=proof, policy=self.policy, expected_order=expected_order,
            set_doc=self.set_doc, set_hash=self.set_hash,
            cached_published_at=self.cached_published_at,
            seen=self._seen, now=now,
        )


def _rebuild_message_fields(proof: dict, policy: dict, expected_order: dict,
                            set_doc: dict, set_hash: str) -> dict:
    """The verifier's OWN reconstruction of what the proof must have bound.

    Crucially this pulls order_id/total_sats from the verifier's authoritative
    ``expected_order`` and verifier_id/set_id/set_hash from policy + pinned set,
    NOT from the proof — so a replayed or re-labelled proof cannot self-declare.
    expiry and key_image are proof-bound (expiry is separately freshness-checked,
    key image is deterministic per key).
    """
    total_sats = expected_order.get("total_sats", expected_order.get("amount"))
    return {
        "order_id": str(expected_order["order_id"]),
        "total_sats": str(int(total_sats)),
        "verifier_id": str(policy["verifier_id"]),
        "set_id": str(set_doc["set_id"]),
        "set_hash": set_hash,
        "expiry": int(proof["expiry"]),
        "key_image": str(proof["key_image"]),
    }


def verify_order_proof_impl(*, proof: Optional[dict], policy: dict,
                            expected_order: dict, set_doc: dict,
                            set_hash: str,
                            cached_published_at: Optional[str],
                            seen: dict,
                            now: Optional[int] = None) -> tuple:
    """Full ordered policy. Returns (ok, reason, meta)."""
    now = now if now is not None else int(time.time())
    k_min = int(policy.get("k_min", 4))

    # 1. proof present and structurally valid
    if proof is None:
        return False, R_MISSING, {}
    if not isinstance(proof, dict):
        return False, R_BAD_STRUCTURE, {}
    for f in _REQUIRED_PROOF_FIELDS:
        if f not in proof:
            return False, R_BAD_STRUCTURE, {}
    if not isinstance(proof["ring"], list) or not isinstance(proof["s"], list):
        return False, R_BAD_STRUCTURE, {}
    if not isinstance(proof["message_fields"], dict):
        return False, R_BAD_STRUCTURE, {}

    ring = proof["ring"]

    # 2. ring subset of pinned set + no duplicates + k_min
    if len(set(ring)) != len(ring):
        return False, R_DUPLICATE_KEYS, {}
    if len(ring) < k_min:
        return False, R_RING_TOO_SMALL, {
            "anon_set_size": len(ring), "set_hash": set_hash,
            "set_id": set_doc["set_id"], "warn_anon_set_small": len(ring) < 2,
        }
    trusted = {m["public_key"] for m in set_doc["members"]}
    for pk in ring:
        if pk not in trusted:
            return False, R_NOT_IN_SET, {}

    # 3. set_hash equals the pinned set content hash; freshness / future-dated
    if proof.get("set_hash") != set_hash:
        return False, R_SET_HASH_MISMATCH, {}
    ok_fresh, fresh_reason = check_freshness(
        set_doc, now=_iso_from_unix(now), cached_published_at=cached_published_at,
    )
    if not ok_fresh:
        if "future" in fresh_reason:
            return False, R_SET_FUTURE, {}
        return False, R_SET_STALE, {}

    # 4. expiry in the future
    if int(proof["expiry"]) <= now:
        return False, R_EXPIRED, {}

    # 5. the verifier holds the order: rebuild + field-by-field equality BEFORE
    #    the signature check.
    expected_fields = _rebuild_message_fields(proof, policy, expected_order,
                                              set_doc, set_hash)
    got_fields = proof["message_fields"]
    for f in _MESSAGE_FIELD_ORDER:
        if str(got_fields.get(f)) != str(expected_fields.get(f)):
            return False, R_ORDER_MISMATCH, {}

    # 6. LSAG signature verifies over the ring
    message = bound_message(expected_fields)
    try:
        sig = LSAGSignature(
            key_image=bytes.fromhex(proof["key_image"]),
            c0=bytes.fromhex(proof["c_0"]),
            responses=[bytes.fromhex(r) for r in proof["s"]],
        )
    except Exception:
        return False, R_BAD_SIGNATURE, {}
    ring_bytes = [bytes.fromhex(pk) for pk in ring]
    if not lsag_verify(message, ring_bytes, sig):
        return False, R_BAD_SIGNATURE, {}

    # 7. key image seen-set scoped per order (one proof per member per order)
    scope = str(expected_order["order_id"])
    bucket = seen.setdefault(scope, set())
    if proof["key_image"] in bucket:
        return False, R_ALREADY_PROVEN, {}
    bucket.add(proof["key_image"])

    return True, "ok", {
        "anon_set_size": len(ring),
        "set_hash": set_hash,
        "set_id": set_doc["set_id"],
        "warn_anon_set_small": len(ring) < 2,
    }


def _iso_from_unix(now: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))


# ---------------------------------------------------------------------------
# Frozen interface S4a imports
# ---------------------------------------------------------------------------

_GATES: dict = {}


def _load_set(policy: dict) -> dict:
    """Load the pinned set file named by ``policy['set_file']``.

    Resolves relative to this file's ``sets/`` sibling, or an absolute path.
    """
    set_file = policy["set_file"]
    if not os.path.isabs(set_file):
        base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sets")
        set_file = os.path.join(base, set_file)
    with open(set_file, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _gate_for(policy: dict) -> OrderGate:
    key = (policy.get("set_slug"), policy.get("set_file"))
    gate = _GATES.get(key)
    if gate is None:
        set_doc = _load_set(policy)
        gate = OrderGate(set_doc, policy)
        _GATES[key] = gate
    return gate


def verify_order_proof(*, proof: Optional[dict], policy: dict,
                       expected_order: dict) -> tuple:
    """(ok, reason, meta) — meta = {'anon_set_size', 'set_hash', 'set_id'}.

    The frozen interface S4a calls. State (fresh-version cache + per-order
    key-image seen-set) is held per (set_slug, set_file), so a repeated call for
    the same order sees the earlier proof's key image.
    """
    gate = _gate_for(policy)
    return gate.verify(proof, expected_order)


def reset_gates() -> None:
    """Clear all gate state (used by tests)."""
    _GATES.clear()


__all__ = [
    "verify_order_proof", "OrderGate", "reset_gates",
    "R_MISSING", "R_BAD_STRUCTURE", "R_NOT_IN_SET", "R_DUPLICATE_KEYS",
    "R_RING_TOO_SMALL", "R_SET_HASH_MISMATCH", "R_SET_STALE", "R_SET_FUTURE",
    "R_EXPIRED", "R_ORDER_MISMATCH", "R_BAD_SIGNATURE", "R_ALREADY_PROVEN",
]
