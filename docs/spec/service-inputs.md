# Service inputs — the standard field-name register (v1, additive)

- **Status:** draft, v1. Additive: fields are added, never renamed or repurposed.
- **Scope:** the *names* of the things a CVM may require from a user, so the
  discovery dashboard can filter services by what they ask for **before** the
  user commits to anything.
- **Companion:** `vocab/service-inputs.json` is the machine-readable copy of this
  document. The kit and the registry read it; this file is the prose of record.

## Why names, and why tags

The value of the register is that "needs a shipping address" is spelled the same
way by every venue adapter, so a user can ask *"show me services that need no
personal data"* and get an answer that is true.

Per ADR-0001 **D2**, only **single-letter** tags are filterable on relays.
Multi-letter tags are payload. So the register is carried as **namespaced values
on the existing `t` tag** — no new tag letter is minted, and it composes with the
class tag from D3:

```
["t","cvm:service:restaurant"]        # what the service is
["t","cvm:req:ship.address"]          # what it requires from the user
["t","cvm:opt:contact.phone"]         # what it accepts but does not require
["t","cvm:req:none"]                  # sentinel: requires no user-supplied data
```

Additions to the register are **new values**, never new letters — that is what
keeps a growing list from turning into a growing tag alphabet.

## The AND problem (read this before designing a filter)

A relay `REQ` with several values for one tag letter is **OR**, never AND:

```
{"#t":["cvm:req:ship.address","cvm:req:contact.phone"]}   # address OR phone
```

There is no way to express "requires both" in a single filter. Therefore:

- the **server-side** `#t` filter is a **coarse prefilter** — pick the rarest
  required field (or the widest useful set) and let the relay narrow;
- the **AND is done locally**, on the cache, by the dashboard. This is consistent
  with D6: the dashboard is a cache, not a proxy, and it already holds the
  announcement content.
- a client that filters only server-side and reports "3 services match" without
  the local AND is **wrong**, not merely imprecise.

## Tiers — the part that makes the filter worth having

Every field carries a tier. The tier is what lets a user say *"nothing
personal"* without reading 40 field names.

| Tier | Meaning | Fields |
|---|---|---|
| `none` | nothing user-supplied | the `cvm:req:none` sentinel |
| `financial` | settlement only, no identity | `payment.amount`, `payment.method` |
| `contact` | identifies or reaches the human | `contact.name`, `contact.phone`, `contact.email`, `contact.messenger` |
| `fulfilment` | needed to deliver or to run the session | `ship.*`, `order.*`, `book.*`, `session.*`, `asset.id` |
| `legal` | required by law or by the venue's terms | `legal.terms`, `legal.invoice_address`, `legal.tax_id` |
| `sensitive` | special-category or health-adjacent | `identity.dob`, `prefs.dietary`, `prefs.allergens`, `identity.gov_id` |

**Filter shorthand.** `cvm:req:none` means *tiers `none`/`financial` only*. A
dashboard MAY offer "no personal data" = `none`+`financial`, "contact only" = +`contact`,
and so on. The tiers are declared here so the dashboard does not invent them.

## The register

Names are `domain.field`, lowercase, `snake_case` inside a segment. A group name
on its own (`ship.address`) is legal shorthand; a group with sub-fields MUST also
publish the sub-fields it actually uses.

**Order / goods**

- `order.items` — the basket (line items + quantities). Usually a tool argument, not a form.
- `order.notes` — free text for the kitchen/handler.
- `order.fulfilment` — `pickup` | `delivery` | `dine_in`.
- `order.when` — requested fulfilment time (ISO 8601, or `asap`).
- `order.channel` — the venue's own rail the order will be placed on (v1 deep-link).

**Shipping**

- `ship.address` — postal address (group).
- `ship.address.street`, `ship.address.city`, `ship.address.postal_code`, `ship.address.country`
- `ship.recipient_name` — may differ from `contact.name`.
- `ship.notes` — doorbell, gate code, floor.

**Contact**

- `contact.name`, `contact.phone`, `contact.email`, `contact.messenger`

**Booking / session (restaurants, chargers, anything with a slot)**

- `book.when`, `book.party_size`, `book.duration`
- `session.start`, `session.duration`, `session.meter` — e.g. kWh budget for a charge session.
- `asset.id` — which charger / table / locker the user is asking about.
- `ev.connector` — connector type (`type2`, `ccs`, `nacs`).
- `ev.plate` — licence plate, when the venue needs it for parking validation.

**Identity / access**

- `identity.dob` — age gate (see `identity.age_over` for the softer form).
- `identity.age_over` — a bare assertion ("over 18"), preferred over a date of birth.
- `identity.gov_id` — government identity document. **Avoid**; if a venue truly
  needs it, the CVM MUST say so in the announcement and the dashboard MUST show
  the `sensitive` badge.
- `auth.membership_set` — the user must present a membership proof for a set the
  provider names (this is the *customer-side* ring case, the mirror of the
  provider-side proof in P12). The value is the set's `a` reference, not a boolean.

**Legal / commercial**

- `legal.terms` — the venue's terms must be accepted.
- `legal.invoice_address`, `legal.tax_id` — business invoices.

**Preferences**

- `prefs.dietary`, `prefs.allergens`, `prefs.spice`, `prefs.language`

**Discounts**

- `voucher.code`

**Payment**

- `payment.amount` — the price actually payable, in `sats` or fiat (unit declared).
- `payment.method` — the rail: `bitcoin-lightning-bolt11`, `bitcoin-cashu`,
  `venue-card`, `cash-on-delivery`. In v1 the **venue's own rail settles** (D5);
  a CVM that accepts a payment method itself is v2 and MUST say so.

## Rules that are not optional

1. **Declare what the flow collects, not what the CVM's own tool signature needs.**
   If the deep-link lands the user on a venue page that asks for an address, that
   address is required by the flow and MUST be declared. Undeclaring it moves the
   surprise to the worst possible moment.
2. **Minimisation is a MUST, not a virtue.** A service MUST NOT require a field it
   does not use. Declaring a wide appetite is not a neutral act — the dashboard
   surfaces it, and an inflated declaration is a spec violation.
3. **Unknown fields fail loud, not quiet.** A reader that meets an unknown
   `cvm:req:*` value MUST surface it as an unknown requirement and MUST NOT count
   the service as "needs nothing". Silent dropping turns a privacy filter into a
   lie.
4. **Absent is not `none`.** A service that declares no `cvm:req:*` tag at all has
   an *unknown* appetite: the dashboard groups it with "unclassified", never with
   `cvm:req:none`.
5. **The register is the vocabulary, the content is the schema.** Tags carry the
   filterable names; the announcement content carries types, patterns, length
   limits and per-field explanations. Multi-letter tags are payload only (D2).

## Growth

- Adding a field is a normal commit to this file **and** to
  `vocab/service-inputs.json` (they MUST stay in step).
- New fields take a tier; if a field does not fit an existing tier, that is a
  discussion, not a new tier by fiat.
- Never rename, never repurpose, never recycle a retired name: the register's
  value is that an old announcement still parses without a lookup table.
- Retiring a field: mark it `deprecated` in the JSON, keep the name reserved.

## Examples

```
# coffee kiosk: money only
["t","cvm:service:restaurant"],["t","cvm:req:none"],["t","cvm:req:payment.amount"]

# pizza delivery
["t","cvm:service:restaurant"],["t","cvm:req:ship.address"],["t","cvm:req:contact.phone"],
["t","cvm:req:order.items"],["t","cvm:opt:order.notes"]

# e-bike charger, member-only
["t","cvm:service:ev-charger"],["t","cvm:req:asset.id"],["t","cvm:req:auth.membership_set"],
["t","cvm:opt:session.duration"]

# pharmacy counter pickup
["t","cvm:service:pharmacy"],["t","cvm:req:contact.name"],["t","cvm:req:contact.phone"],
["t","cvm:opt:identity.dob"]
```

## Open questions

1. Should the tier also be published as a tag (`cvm:req:tier:sensitive`) so the
   "no personal data" filter can be a single server-side `#t`? Cost: one more tag
   per announcement; benefit: the coarse prefilter gets much better.
2. Do we need `cvm:req:none` at all if `payment.*` is the only non-personal tier,
   or is the sentinel the clearer contract?
3. Is `order.items` an input or a tool argument? It behaves like both; v1 treats
   it as a tool argument *and* declares it, because discovery filtering should be
   able to exclude basket-only services.
