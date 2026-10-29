# x280 customer API — Option A (facilitator LNURLP)

The customer-facing service is unprivileged:

- runs as the `cvm` user, not the operator;
- holds **no OpenBao AppRole and no treasury/2fiat key**;
- prices the basket and asks the root-side LNURLP server for an invoice;
- never pays: `POST /orders/:id/pay` is a 409. The customer pays the BOLT11.

## Flow

```
customer UI /order-next/
  -> POST /order-next-api/orders (this service)
  -> POST /lnurlp/internal/orders (Caddy -> T14 LNURLP, bearer token)
  -> treasury mint-adapter invoice
customer wallet pays the BOLT11
  -> LNURLP sees the treasury credit; order paid
facilitator page /lnurlp/facilitator
  -> place venue order with the card, solve captcha/3DS, confirm venue ref
customer UI polls /orders/:id -> paid + venue_ref -> confirmed
```

## Install

Prerequisites:
- the LNURLP server is live and the facilitator page works;
- OpenBao `lnurlp-internal` is granted to x280;
- `$2.10` 2fiat card is available for the venue smoke test.

```bash
cd ~/repos/contextvm-services
bash services/restaurant-cvm/deploy/x280-lnurlp/install.sh
```

The installer creates the `cvm` user, installs Deno system-wide, copies the
service/menu to `/opt/cvm` and `/etc/cvm`, reads the LNURLP internal token from
OpenBao into `/etc/cvm/customer-api.env` (0600 root), replaces the old
operator-run unit, publishes the Option A UI, and checks the public menu.

## Security notes

- The service runs as `cvm`; `ProtectHome=true` prevents reading the operator's
  `~/.hermes/openbao`.
- The only secret in its environment is the LNURLP internal bearer, which can
  create/read orders but cannot pay, refund, or confirm a venue order.
- The facilitator token (list/confirm) stays on T14 and is entered in the
  facilitator page; it is never shipped to x280.
- The treasury/2fiat keys remain with the facilitator ContextVM (c08r4d0r), not
  the customer service.

## Smoke test

1. Open `https://cvm-pwa.orangesync.tech/order-next/`; add a small item.
2. **Create order** -> QR/WebLN BOLT11 from the facilitator LNURLP.
3. Pay it from the customer/second wallet.
4. `/order-next/` shows paid; the facilitator page lists the paid order.
5. Facilitator: use the 2fiat card on the venue page, solve hCaptcha/3DS, enter
   the venue reference, confirm.
6. `/order-next/` shows the restaurant confirmed; pick up.
