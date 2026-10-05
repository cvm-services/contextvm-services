"""Tests for the restaurant CVM ring gate (TDD — RED first).

Every verification rule gets a test; every failure has a STABLE reason string.
The two soundness tests are the point of the whole design:

  * the non-member attack (ring = {attacker key, scraped trusted keys}) MUST
    fail — a naive verifier whose rule is "the ring contains a trusted key"
    accepts it;
  * a VALID signature that binds a different amount MUST be refused with
    ``order-mismatch`` before the signature check.

Run (from the worktree root):

    .venv/bin/python -m pytest services/restaurant-cvm/trust/tests -v
"""
from __future__ import annotations

import copy
import json
import os
import time

import pytest

from trust.curve import generate_key_pair  # noqa: E402
from trust.gate import (  # noqa: E402
    R_ALREADY_PROVEN,
    R_BAD_SIGNATURE,
    R_BAD_STRUCTURE,
    R_DUPLICATE_KEYS,
    R_EXPIRED,
    R_MISSING,
    R_NOT_IN_SET,
    R_ORDER_MISMATCH,
    R_RING_TOO_SMALL,
    R_SET_FUTURE,
    R_SET_HASH_MISMATCH,
    R_SET_STALE,
    OrderGate,
    reset_gates,
    verify_order_proof,
)
from trust.lsag import sign  # noqa: E402
from trust.prover import bound_message, build_proof  # noqa: E402
from trust.trustset import set_content_hash  # noqa: E402

_TRUST_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SET_PATH = os.path.join(_TRUST_DIR, "sets", "burger-vendors-berlin.json")
_KEYS_PATH = os.path.join(_TRUST_DIR, "tests", "keys.local.json")


@pytest.fixture(scope="session")
def world():
    set_doc = json.load(open(_SET_PATH, "r", encoding="utf-8"))
    keys = json.load(open(_KEYS_PATH, "r", encoding="utf-8"))
    policy = {
        "required": True,
        "k_min": 4,
        "set_slug": set_doc["set_id"],
        "set_file": "burger-vendors-berlin.json",
        "seen_scope": "order",
        "expiry_s": 3600,
        "verifier_id": keys["verifier_id"],
    }
    return {"set_doc": set_doc, "keys": keys, "policy": policy}


def _order(order_id="order-1", total_sats=27900):
    return {"order_id": order_id, "total_sats": total_sats}


def _member_keys(keys, n=4):
    return [m["public_key"] for m in keys["members"][:n]]


def _proof(world, order, member_index=2, ring=None, signer_secret=None):
    keys = world["keys"]
    member = keys["members"][member_index]
    ring = ring or _member_keys(keys, 4)
    return build_proof(
        member_secret_hex=member["secret"],
        member_public_key_hex=member["public_key"],
        ring_hex=ring,
        set_doc=world["set_doc"],
        policy=world["policy"],
        expected_order=order,
    )


# ---------------------------------------------------------------------------
# 1. structural
# ---------------------------------------------------------------------------

def test_missing_proof_is_rejected(world):
    reset_gates()
    ok, reason, meta = verify_order_proof(proof=None, policy=world["policy"],
                                          expected_order=_order())
    assert ok is False and reason == R_MISSING


def test_malformed_proof_is_rejected(world):
    reset_gates()
    ok, reason, _ = verify_order_proof(proof={"c_0": "00"}, policy=world["policy"],
                                       expected_order=_order())
    assert ok is False and reason == R_BAD_STRUCTURE


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------

def test_happy_path_verifies_and_reports_anon_set_size(world):
    reset_gates()
    order = _order()
    proof = _proof(world, order)
    ok, reason, meta = verify_order_proof(proof=proof, policy=world["policy"],
                                         expected_order=order)
    assert ok is True, reason
    assert meta["anon_set_size"] == 4
    assert meta["set_id"] == "burger-vendors-berlin"
    assert meta["set_hash"] == world["set_doc"]["set_hash"]
    assert meta["warn_anon_set_small"] is False


# ---------------------------------------------------------------------------
# 2. ring subset / duplicates / k_min
# ---------------------------------------------------------------------------

def test_ring_key_outside_pinned_set_is_rejected(world):
    reset_gates()
    attacker_sk, attacker_pk = generate_key_pair()
    ring = [attacker_pk.hex(), *_member_keys(world["keys"], 3)]
    order = _order()
    proof = _proof(world, order, member_index=2,
                   ring=ring, signer_secret=None)
    # re-sign as attacker at position 0
    member = world["keys"]["members"][2]
    from trust.prover import key_image_for
    ki = key_image_for(member["secret"], member["public_key"]).hex()
    mf = copy.deepcopy(proof["message_fields"])
    mf["key_image"] = ki
    proof["message_fields"] = mf
    proof["key_image"] = ki
    proof["ring"] = ring
    sig = sign(bound_message(mf), [bytes.fromhex(pk) for pk in ring], 0, attacker_sk)
    proof["c_0"] = sig.c0.hex()
    proof["s"] = [r.hex() for r in sig.responses]
    ok, reason, _ = verify_order_proof(proof=proof, policy=world["policy"],
                                       expected_order=order)
    assert ok is False and reason == R_NOT_IN_SET


def test_duplicate_ring_keys_are_rejected(world):
    reset_gates()
    keys = world["keys"]
    ring = [_member_keys(keys, 1)[0], _member_keys(keys, 1)[0],
            _member_keys(keys, 2)[1], _member_keys(keys, 2)[1]]
    order = _order()
    proof = _proof(world, order, member_index=0, ring=ring)
    ok, reason, _ = verify_order_proof(proof=proof, policy=world["policy"],
                                       expected_order=order)
    assert ok is False and reason == R_DUPLICATE_KEYS


def test_ring_below_k_min_is_rejected(world):
    reset_gates()
    order = _order()
    proof = _proof(world, order, member_index=0, ring=_member_keys(world["keys"], 3))
    ok, reason, meta = verify_order_proof(proof=proof, policy=world["policy"],
                                          expected_order=order)
    assert ok is False and reason == R_RING_TOO_SMALL
    assert meta["anon_set_size"] == 3


# ---------------------------------------------------------------------------
# 3. set hash / freshness / future-dated
# ---------------------------------------------------------------------------

def test_wrong_set_hash_is_rejected(world):
    reset_gates()
    order = _order()
    proof = _proof(world, order)
    proof["set_hash"] = "00" * 32
    ok, reason, _ = verify_order_proof(proof=proof, policy=world["policy"],
                                       expected_order=order)
    assert ok is False and reason == R_SET_HASH_MISMATCH


def test_stale_set_version_is_rejected(world):
    order = _order()
    proof = _proof(world, order)
    set_doc = world["set_doc"]
    gate = OrderGate(set_doc, world["policy"],
                     cached_published_at="2030-01-01T00:00:00Z")
    ok, reason, _ = gate.verify(proof, order)
    assert ok is False and reason == R_SET_STALE


def test_future_dated_set_is_rejected(world):
    order = _order()
    proof = _proof(world, order)
    set_doc = copy.deepcopy(world["set_doc"])
    set_doc["published_at"] = "2999-01-01T00:00:00Z"
    gate = OrderGate(set_doc, world["policy"])
    ok, reason, _ = gate.verify(proof, order)
    assert ok is False and reason == R_SET_FUTURE


# ---------------------------------------------------------------------------
# 4. expiry
# ---------------------------------------------------------------------------

def test_expired_proof_is_rejected(world):
    reset_gates()
    order = _order()
    proof = _proof(world, order)
    proof["expiry"] = int(time.time()) - 10
    ok, reason, _ = verify_order_proof(proof=proof, policy=world["policy"],
                                       expected_order=order)
    assert ok is False and reason == R_EXPIRED


# ---------------------------------------------------------------------------
# 5. authoritative order binding (the replay test)
# ---------------------------------------------------------------------------

def test_valid_signature_binding_different_amount_is_order_mismatch(world):
    """A VALID signature that binds a different amount MUST be refused.

    This is the case a naive verifier accepts: the LSAG signature is perfectly
    valid, but it binds 1 sat while the verifier's order says 27900.
    """
    reset_gates()
    order = _order(total_sats=27900)
    proof = _proof(world, order)  # valid proof over 27900
    # re-bind the verifier to a DIFFERENT amount: the proof is still valid for
    # its own message, but must not match the verifier's order.
    other_order = _order(total_sats=1)
    ok, reason, _ = verify_order_proof(proof=proof, policy=world["policy"],
                                       expected_order=other_order)
    assert ok is False and reason == R_ORDER_MISMATCH


def test_replay_onto_another_order_is_order_mismatch(world):
    reset_gates()
    order_a = _order(order_id="order-A")
    proof = _proof(world, order_a)
    order_b = _order(order_id="order-B")
    ok, reason, _ = verify_order_proof(proof=proof, policy=world["policy"],
                                       expected_order=order_b)
    assert ok is False and reason == R_ORDER_MISMATCH


# ---------------------------------------------------------------------------
# 6/7. key image scoped per order
# ---------------------------------------------------------------------------

def test_same_proof_twice_for_one_order_is_already_proven(world):
    reset_gates()
    order = _order()
    proof = _proof(world, order)
    first = verify_order_proof(proof=proof, policy=world["policy"],
                               expected_order=order)
    assert first[0] is True, first[1]
    second = verify_order_proof(proof=proof, policy=world["policy"],
                                expected_order=order)
    assert second[0] is False and second[1] == R_ALREADY_PROVEN


def test_key_image_is_deterministic_and_scoped_per_order(world):
    """Same key -> same image; same image on a DIFFERENT order is fine."""
    reset_gates()
    member = world["keys"]["members"][2]
    order_a = _order(order_id="order-A")
    order_b = _order(order_id="order-B")
    proof_a = _proof(world, order_a, member_index=2)
    proof_b = _proof(world, order_b, member_index=2)
    assert proof_a["key_image"] == proof_b["key_image"]  # deterministic per key
    print(f"\nkey image (member 2, two orders): {proof_a['key_image']}")

    a = verify_order_proof(proof=proof_a, policy=world["policy"],
                           expected_order=order_a)
    assert a[0] is True, a[1]
    b = verify_order_proof(proof=proof_b, policy=world["policy"],
                           expected_order=order_b)
    assert b[0] is True, b[1]


# ---------------------------------------------------------------------------
# 8. non-member attack (the regression test for the whole design)
# ---------------------------------------------------------------------------

def test_non_member_attack_must_fail(world):
    """ring = {attacker key, scraped trusted keys}, signed by the attacker.

    A naive verifier ("is a trusted key in the ring?") ACCEPTS this. The real
    policy requires the ring to be a SUBSET of the pinned set, so it fails.
    """
    reset_gates()
    attacker_sk, attacker_pk = generate_key_pair()
    scraped = _member_keys(world["keys"], 3)  # three scraped trusted pubkeys
    ring = [attacker_pk.hex(), *scraped]
    order = _order()

    # Build the proof signed by the attacker at position 0.
    set_doc = world["set_doc"]
    set_hash = set_content_hash(set_doc)
    from trust.prover import key_image_for, build_message_fields
    # attacker's key image is over its own key
    ki = key_image_for(attacker_sk.hex(), attacker_pk.hex()).hex()
    mf = build_message_fields(expected_order=order, policy=world["policy"],
                              set_doc=set_doc, set_hash=set_hash,
                              expiry=int(time.time()) + 3600, key_image_hex=ki)
    sig = sign(bound_message(mf), [bytes.fromhex(pk) for pk in ring], 0, attacker_sk)
    proof = {
        "c_0": sig.c0.hex(),
        "s": [r.hex() for r in sig.responses],
        "ring": ring,
        "key_image": ki,
        "set_id": set_doc["set_id"],
        "set_hash": set_hash,
        "created_at": int(time.time()),
        "expiry": int(time.time()) + 3600,
        "message_fields": mf,
    }

    # Naive check — the bug this test exists to prevent:
    trusted = {m["public_key"] for m in set_doc["members"]}
    naive = any(pk in trusted for pk in ring)
    assert naive is True  # "a trusted key is present" — that is NOT sound

    ok, reason, _ = verify_order_proof(proof=proof, policy=world["policy"],
                                       expected_order=order)
    assert ok is False
    assert reason == R_NOT_IN_SET
