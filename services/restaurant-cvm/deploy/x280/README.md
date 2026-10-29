# x280 customer API — FIPS deployment

The customer API runs on x280 and is reachable publicly only through the FIPS
exit node (`testserver2`, SSH alias `vps2fips`):

```
browser -> https://cvm-pwa.orangesync.tech/order-next/        (static UI)
browser -> https://cvm-pwa.orangesync.tech/order-next-api/*   (Caddy on testserver2)
              -> http://[fd36:3c0f:d6f:8029:ea50:958b:672e:bb0]:8793 (FIPS)
```

The old `/order/`, `/console/` and `/api/` demo is untouched.

## Files

| File | Purpose |
|---|---|
| `cvm-customer-api.service` | systemd unit; runs as `c08r4d0r`, reads `/etc/cvm/customer-api.env` |
| `customer-api.env.example` | non-secret config: port, host, menu, rail, FX, card, kit |
| `cvm-import-map.json` | maps `nostr-tools` for the kit's NWC wallet under Deno |
| `61-cvm-customer-api.nft` | FIPS ingress: only testserver2 `/128` → tcp/8793 |
| `install.sh` | idempotent install on x280; preserves an existing env file |
| `publish-order-next.sh` | ships the UI to `/opt/tollgate/cvm-pwa/order-next/` |

## Order of operations

1. Merge this directory, the `CVM_CUSTOMER_HOST` change and the Caddy vhost
   route in `cvm-registry`.
2. On x280, from the repo checkout:
   ```bash
   bash services/restaurant-cvm/deploy/x280/install.sh
   ```
3. From the `cvm-registry` checkout, install the vhost (it carries both
   `/order-next/` and `/order-next-api/*`):
   ```bash
   HOST=vps2fips bash deploy/deploy-pwa.sh
   ```
4. On x280:
   ```bash
   bash services/restaurant-cvm/deploy/x280/publish-order-next.sh
   ```

## Secrets

The service resolves `nwc_url` and `two_fiat_token` from
`secret/data/fleet/food-order` using the x280 AppRole. The env file must not
contain `CVM_ORDER_*` values. The OpenBao grant and rotation notes are in
`hermes-trust-root/docs/PLAN-food-order-openbao.md`.

## Spend boundary

`/order-next-api` is public and `POST /orders` + `/pay` makes the treasury pay
2fiat's invoice. The treasury cap (`21,212` sats) and balance are the only
controls. Do not create an order during a deployment smoke test.
