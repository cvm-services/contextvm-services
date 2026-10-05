"""Pinned trust set: a curated list of member keys, pinned by id + content hash.

The set is a NIP-51 kind-30000 list: ``d=<slug>``, members as ``p`` tags (x-only)
plus a ``members`` array carrying the full 33-byte compressed keys the LSAG
verifier needs (D9). Pinning is what stops a prover from substituting a set that
happens to contain their own key.

Content-hash encoding (byte-for-byte port of the fleet's ``trustset.ts``):
sha256 over utf8(set_id) || utf8(published_at) || each member's compressed-pubkey
hex, hex-sorted. Hex sorting is what makes it independent of member order.
"""
from __future__ import annotations

import hashlib
from typing import Optional


def set_content_hash(set_doc: dict) -> str:
    """Content hash of a trust-set document (order-independent, pin-stable)."""
    h = hashlib.sha256()
    h.update(str(set_doc["set_id"]).encode("utf-8"))
    h.update(str(set_doc["published_at"]).encode("utf-8"))
    member_hexes = sorted(m["public_key"] for m in set_doc["members"])
    for hex_ in member_hexes:
        h.update(hex_.encode("utf-8"))
    return h.hexdigest()


def member_keys(set_doc: dict) -> list:
    """The full 33-byte compressed member keys as hex strings."""
    return [m["public_key"] for m in set_doc["members"]]


def check_freshness(set_doc: dict, now: str, cached_published_at: Optional[str] = None) -> tuple:
    """Reject future-dated sets and sets older than the newest one cached.

    Removal from a trust set is always soft: nothing can call back a signature
    already handed over. Monotonic version acceptance plus a declared expiry is
    the honest mitigation, and this is where the version half lives.
    """
    published_at = str(set_doc["published_at"])
    if published_at > now:
        return False, (
            f"trust set is future-dated ({published_at} > verifier's clock {now})"
        )
    if cached_published_at is not None and published_at < cached_published_at:
        return False, (
            "trust set is older than the cached newer version "
            f"({published_at} < {cached_published_at})"
        )
    return True, "fresh"
