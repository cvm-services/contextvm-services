#!/usr/bin/env python3
"""Generate the demo trust set + private keys for the restaurant CVM ring gate.

Run (venv with coincurve):

    .venv/bin/python services/restaurant-cvm/trust/tests/gen_keys.py

Writes:
  - ``trust/sets/burger-vendors-berlin.json``  (PUBLIC keys only, committed)
  - ``trust/tests/keys.local.json``            (PRIVATE keys, gitignored)

The set is a NIP-51 kind-30000 list: ``d=<slug>``, members as ``p`` tags
(x-only) plus a full ``members`` array carrying the 33-byte compressed keys the
verifier needs (D9). A curator key signs the set in spirit (the set carries the
curator's npub as the ``verifier_id``); the demo set is a *demonstration*, not
an anonymity claim — 4 members make a k=4 ring but the real set would be larger.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from trust.curve import base_mul, point_to_bytes, scalar_from_bytes  # noqa: E402
from trust.trustset import set_content_hash  # noqa: E402

SET_ID = "burger-vendors-berlin"
PUBLISHED_AT = "2026-10-05T00:00:00Z"
N_MEMBERS = 8
ADMISSION = (
    "Members admitted in person by the curator (demo fixture). Membership "
    "attests the set owner vouched for this key — it does not attest funds, "
    "delivery, or solvency."
)

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def _hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (tobits - bits)) & maxv)
    return ret


def npub_from_pubkey(compressed33: bytes) -> str:
    xonly = compressed33[1:33]
    data = _convertbits(list(xonly), 8, 5)
    values = _hrp_expand("npub") + data
    polymod = _polymod(values + [0] * 6) ^ 1
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return "npub1" + "".join(CHARSET[d] for d in data + checksum)


def _random_secret() -> bytes:
    return os.urandom(32)


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    trust_dir = os.path.dirname(here)
    sets_dir = os.path.join(trust_dir, "sets")
    os.makedirs(sets_dir, exist_ok=True)

    curator_sk = _random_secret()
    curator_pk = point_to_bytes(base_mul(scalar_from_bytes(curator_sk)))
    verifier_id = npub_from_pubkey(curator_pk)

    members = []
    member_secrets = []
    p_tags = []
    for i in range(N_MEMBERS):
        sk = _random_secret()
        pub = point_to_bytes(base_mul(scalar_from_bytes(sk)))
        label = f"vendor-{i:02d}"
        members.append({
            "public_key": pub.hex(),
            "label": label,
            "basis": "met-in-person",
            "tier": "silver",
            "expires_at": "2030-01-01T00:00:00Z",
        })
        member_secrets.append({"label": label, "secret": sk.hex(), "public_key": pub.hex()})
        # NIP-51 'p' tag: [p, x-only-hex, relay, label, basis, tier, expiry]
        p_tags.append(["p", pub[1:33].hex(), "", label, "met-in-person", "silver",
                       "2030-01-01T00:00:00Z"])

    tags = [["d", SET_ID], ["title", "Burger vendors — Berlin (demo set)"], *p_tags]
    set_doc = {
        "kind": 30000,
        "d": SET_ID,
        "set_id": SET_ID,
        "title": "Burger vendors — Berlin (demo set)",
        "published_at": PUBLISHED_AT,
        "created_at": 1791216000,  # 2026-10-05T00:00:00Z
        "content": ADMISSION,
        "curator_npub": verifier_id,
        "tags": tags,
        "members": members,
    }
    set_doc["set_hash"] = set_content_hash(set_doc)

    set_path = os.path.join(sets_dir, f"{SET_ID}.json")
    with open(set_path, "w", encoding="utf-8") as fh:
        json.dump(set_doc, fh, indent=2, sort_keys=True)
        fh.write("\n")

    # Keep policy.json's verifier_id in sync with the generated curator npub.
    policy_path = os.path.join(trust_dir, "policy.json")
    policy = json.load(open(policy_path, "r", encoding="utf-8"))
    policy["verifier_id"] = verifier_id
    policy["set_slug"] = SET_ID
    policy["set_file"] = f"{SET_ID}.json"
    with open(policy_path, "w", encoding="utf-8") as fh:
        json.dump(policy, fh, indent=2, sort_keys=True)
        fh.write("\n")

    keys_doc = {
        "set_id": SET_ID,
        "published_at": PUBLISHED_AT,
        "set_hash": set_doc["set_hash"],
        "verifier_id": verifier_id,
        "curator": {"secret": curator_sk.hex(), "public_key": curator_pk.hex()},
        "members": member_secrets,
    }
    keys_path = os.path.join(here, "keys.local.json")
    with open(keys_path, "w", encoding="utf-8") as fh:
        json.dump(keys_doc, fh, indent=2, sort_keys=True)
        fh.write("\n")

    print(f"wrote {set_path}")
    print(f"wrote {keys_path}")
    print(f"set_id={SET_ID} members={N_MEMBERS}")
    print(f"set_hash={set_doc['set_hash']}")
    print(f"verifier_id (curator npub)={verifier_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
