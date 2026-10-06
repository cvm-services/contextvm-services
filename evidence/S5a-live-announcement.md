# S5a — live evidence: the nosms announcement is conformant AND discoverable

Card `t_38d3f879`. Run 2026-10-05 ~17:35 UTC. No claims here that a command did
not print.

## 1. Re-announced through the kit port

```
$ CVM_NSEC=$(cat ~/.hermes/state/nosms-cvm-server-nsec.key) \
  python3.13 scripts/run_cvm_server.py --announce \
    --relays wss://relay.primal.net wss://relay.contextvm.org wss://relay2.contextvm.org

[nosms-cvm] server npub npub1al953lfy7nv5qjwhcw8u2p0uuq0dwmjes3g4rgjxqlke75nxsd9q6lw3w9
[nosms-cvm] transport   email_gateway (best_effort=True, delivery_receipts=False)
[nosms-cvm] emit tier=financial tags=[["d","nosms"],["t","cvm:service:sms"],["t","sms"],
  ["t","contextvm"],["t","cvm:req:payment.amount"],["t","cvm:req:none"],
  ["t","cvm:tier:financial"],["cap","tool:sms.send","2900","sats"],
  ["r","https://nosms.orangesync.tech/llms.txt"],["pmi","bitcoin-cashu","explicit_gating"],
  ["name","nosms"],["about","…"],["website","…"]]
[nosms-cvm] announcement kind 11316: SendEventOutput(id=EventId(
  6b3e96f495a4dab276c3971d6c8b63ec8679b5e3206433f07a92310fee3a2900),
  success=[primal, relay2.contextvm.org, relay.contextvm.org], failed={})
[nosms-cvm] announcement kind 11317: SendEventOutput(id=EventId(
  b2d22f5b9c95ddbbce4932e23a0a7471ad7b445b2c7061cef04a03c95ca2e3f0),
  success=[primal, relay.contextvm.org, relay2.contextvm.org], failed={})
```

## 2. Read back with a fresh subscription — `nak req -k 11316 -a <npub> wss://relay.primal.net`

```json
{"kind":11316,"id":"6b3e96f495a4dab276c3971d6c8b63ec8679b5e3206433f07a92310fee3a2900",
 "pubkey":"efcb48fd24f4d94049d7c38fc505fce01ed76e59845151a24607ed9f5266834a",
 "created_at":1791214505,
 "tags":[["d","nosms"],["t","cvm:service:sms"],["t","sms"],["t","contextvm"],
         ["t","cvm:req:payment.amount"],["t","cvm:req:none"],["t","cvm:tier:financial"],
         ["cap","tool:sms.send","2900","sats"],
         ["r","https://nosms.orangesync.tech/llms.txt"],
         ["pmi","bitcoin-cashu","explicit_gating"],["name","nosms"],["about","…"],
         ["website","https://nosms.orangesync.tech/llms.txt"]]}
```

Every gap from the card is closed on the wire; the replaceable event supersedes
the old `e10505f2…` (which carried `contract` + three `cap` tags).

## 3. The tags are actually FILTERABLE (P2's MUST)

`emitAnnouncementTags` cannot check this — it is a relay property — and the spec
says a tag that does not match is "a silent discovery failure". So it was
measured, on all three relays, with a `#t` filter:

```
$ nak req -k 11316 -a <npub> -t 't=cvm:service:sms' <relay>

wss://relay.primal.net        HIT 6b3e96f495a4  tier=['cvm:tier:financial']  matches: 1
wss://relay.contextvm.org     HIT 6b3e96f495a4  tier=['cvm:tier:financial']  matches: 1
wss://relay2.contextvm.org    HIT 6b3e96f495a4  tier=['cvm:tier:financial']  matches: 1
```

## 4. Regression proof — the OLD non-standard `contract` tag is not filterable

Same relay, same event, filtered on the tag the old announcement used instead of
`r`:

```
$ nak req -k 11316 -a <npub> -t 'contract=https://nosms.orangesync.tech/llms.txt' wss://relay.primal.net
0
$ nak req -k 11316 -a <npub> -t 'r=https://nosms.orangesync.tech/llms.txt' wss://relay.primal.net
1
$ nak req -k 11316 -a <npub> -t 't=cvm:tier:financial' wss://relay.primal.net
1
```

A client trying to find this service by its contract URL could not, before. The
`r` tag answers (section 3 is the same event found by a single-letter filter).

## 5. What is NOT claimed

- No delivery receipt exists on this rail, so nothing here speaks to message
  delivery — this card is about discovery only.
- The paid send path is unchanged by this card (S5c records the e2e flow).
- relay.damus.io is IP-banned from this host and was not used (card pitfall note).
