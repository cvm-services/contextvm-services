# Handover — OpenBao: what the food-order workstream needs

> **SUPERSEDED IN PART (2026-10-30).** The live architecture is different from what
> this document first assumed, and the first draft asked for something that already
> exists. Corrections below; read this box before the body.
>
> 1. **The service is DEPLOYED and RUNNING** on **x280** — not vps2fips, and not
>    waiting on me. `cvm-customer-api.service` is active, serving the real Three
>    Buddies menu over the FIPS address `[fd36:...:bb0]:8793` (verified: `GET /menu`
>    → 200, Cheeseburger Menü 17500 sats / EUR 14).
> 2. **The customer pays the facilitator via LNURLP**, and the **treasury pays
>    2fiat**. `secret/fleet/2fiat` already exists and is already materialized on
>    x280. Asking for `two_fiat_token` in a new path was wrong: it would have
>    created a second copy of a working credential.
> 3. **Only `nwc_url` is actually missing**, and the only reason it matters is the
>    treasury leg (2fiat top-up). `secret/data/fleet/food-order` returns **403 for
>    the x280 AppRole** — measured, not assumed.
> 4. **The spend ceiling I kept requesting already exists**: a documented treasury
>    cap of **21,212 sats**. I should have read the deployment README before asking.
>
> So the ask collapses to: **grant x280 read on `secret/data/fleet/food-order`
> and put `nwc_url` in it** — unless the treasury leg has been retired, in which
> case nothing is needed from the vault at all and this document is obsolete.

**For:** the context window that manages OpenBao on T14
**From:** the food-order / sats-checkout workstream (`cvm-services/contextvm-services`)
**Date:** 2026-10-26
**Status:** the service is built and refuses to start without these values. Nothing is deployed.

---

## 1. What this workstream needs, in one table

| Logical name | Vault key | Used for | If missing |
|---|---|---|---|
| `nwc_url` | `nwc_url` | paying 2fiat's top-up invoices from the fleet treasury (NIP-47) | service exits 3, `fatal: missing_secret` |
| `two_fiat_token` | `two_fiat_token` | 2fiat API: create card top-ups, read card balance | service exits 3, `fatal: missing_secret` |

**Path:** `secret/data/fleet/food-order` (KV v2 — data lives under `data.data`).

**Reader:** node `x280`, AppRole `fleet-node-x280`.

**Not in the vault, deliberately:** the card id, the EUR→USD factor and its
provenance, ports, and the operator token. Those are configuration, not secrets;
they live in the unit's `EnvironmentFile` where they can be reviewed in a diff.

---

## 2. The exact contract the code already implements

`services/restaurant-cvm/src/secret.ts` resolves in this order and reports which
one it used (`source: env | openbao | file`):

1. **Environment** — `CVM_ORDER_NWC_URL`, `CVM_ORDER_TWO_FIAT_TOKEN`. This is how a
   systemd unit receives a value after materialising it from the vault. Nothing on
   disk, nothing in `ps`.
2. **OpenBao** — AppRole login, then `GET /v1/secret/data/fleet/food-order`, then
   `data.data[name]`.
3. **A `0600` file** — `~/.hermes/secrets/food-order.json`, the documented stopgap.
   **Disabled outright when the service runs as `payment`**, which is how it will
   run in production (`allowFileFallback: false`).

A missing value is an **error**, never an empty string. An AppRole login that
returns no client token stops rather than reading unauthenticated and later
blaming the vault.

---

## 3. What I need the operator to do — three actions

### Action 1 — create the path

```bash
# on T14, via whatever broker/approval flow the vault CW uses
bao kv put secret/data/fleet/food-order \
  nwc_url="nostr+walletconnect://<treasury pubkey>?relay=<relay>&secret=<hex>" \
  two_fiat_token="<2fiat API token>"
```

The `nwc_url` must be the **treasury** wallet, not a mint wallet. It is used to pay
outgoing invoices, so it needs spendable balance and a NIP-47 server that implements
`pay_invoice`.

### Action 2 — grant read to the node

Policy for `fleet-node-x280`:

```hcl
path "secret/data/fleet/food-order" {
  capabilities = ["read"]
}
```

Read only. This service never writes to the vault. If a write grant is created for
convenience, please say so explicitly, because it changes the blast radius of a
compromised service.

### Action 3 — tell me it is done, and which of these is true

- [ ] values written by the operator directly
- [ ] values written via a broker request (needs 2 approvals — please name the approvers)
- [ ] `nwc_url` deliberately withheld; only `two_fiat_token` provisioned

I will not read the values. I only need to know the path exists and that
`fleet-node-x280` can read it.

---

## 4. How to verify without printing secrets

```bash
# 1. login as the node and confirm the path is readable (prints KEY NAMES ONLY)
bao login -method=approle role_id=@/path/role_id secret_id=@/path/secret_id >/dev/null
bao kv get -format=json secret/data/fleet/food-order \
  | jq -r '.data.data | keys[]'
# expect: nwc_url, two_fiat_token   (names only - no values)

# 2. prove the grant is the ONLY thing that changed
bao token lookup -format=json | jq -r '.data.policies[]'
# expect: default, fleet-node-x280
```

Then, from the service host, the honest end-to-end check is the service's own
resolver — it prints the **source** and **length**, never the value:

```bash
CVM_RAIL_URL=https://mint.minibits.cash/Bitcoin ... deno run --allow-all src/serve_customer.ts
# success line includes: "nwc_configured": true
```

---

## 5. Failure modes the service reports (so we can tell them apart)

| Output | Meaning | Fix |
|---|---|---|
| `fatal: missing_secret`, `not in CVM_ORDER_…, not in OpenBao, and no usable 0600 fallback` | path absent, or grant absent, or key name misspelled | Actions 1–2 |
| `fatal: rail_config`, `CVM_USD_PER_EUR is not set` | vault is fine; the FX factor is missing from config | not a vault issue |
| `wallet_unavailable`, `tried: …/lnwallet.ts` | the service kit module is not where `CVM_KIT_WALLET` points | not a vault issue |
| service starts but `nwc_configured: false` | impossible on the payment path — it exits first | check which env the unit actually loads |

**403 from the vault is not "no secret".** The resolver distinguishes them and the
loader falls through to the file only when the file fallback is permitted — which on
the payment path it is not.

---

## 6. Rotation

- `two_fiat_token`: rotate in 2fiat, write the new value, restart the unit. No
  session state depends on it.
- `nwc_url`: rotating the treasury wallet changes the spending identity. Coordinate
  it — any in-flight `outcome_unknown` payment must be reconciled against the **old**
  wallet before the URL changes, or reconciliation becomes impossible.
- Neither value is ever logged, so there is no log-scrubbing to do after rotation.

---

## 7. What I will do once you confirm

1. Point the systemd unit at `/etc/cvm/customer-api.env` materialised from the vault
   at start (never a committed file).
2. Run the service with `allowFileFallback: false` and confirm it reports
   `source: openbao`.
3. Record the confirmation in the PR — path, policy name, and the observed
   `source` — without the values.

**Not needed from you:** the card id, the FX factor, ports, the operator token, or
any change to the relay configuration.
