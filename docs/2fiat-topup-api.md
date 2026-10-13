# 2fiat top-up — the real API (measured by driving the UI, 2026-10-13)

Discovered with Playwright driving the actual wallet UI and recording the app's
own XHR calls. The UI's calls ARE the contract: this is measured, not inferred.

## The flow the UI performs

1. Click a card on `/wallet/<token>/my-cards` → card detail panel.
2. Type an amount into the **Top-up** field. This reveals the **rail selector**:
   `BTC LN` | `XMR` | `BTC` | `Altcoins` (this is `GET /api/v1/btc-currencies`).
3. Choose **BTC LN** (Lightning) → the app POSTs the two calls below.
4. The app navigates to a **BTCPay-style checkout** at the returned
   `checkoutLink`, which renders the Lightning invoice for US to pay.

## The two endpoints

### 1. Availability check (no side effect)

```
POST /api/v1/prepaid-cards/topup/{cardId}/check-availability
     {"topupValue": "5"}
 ->  200 {"neededAmount": 5, "canInstantFull": true, "instantAmount": 5}
```

### 2. Create the top-up order (creates a payment order; moves no money)

```
POST /api/v1/prepaid-cards/topup/{cardId}
     {"topupValue": "5", "selectedMethod": "BTC-LN"}
 ->  200 {
       "id": "<order id>",
       "storeId": "...",
       "amount": "5.33",                  // ← THE FEE, measured: 5.00 → 5.33
       "paidAmount": "0",
       "checkoutLink": "https://2fiat.com/pay/i/<order id>",
       "status": "New",
       "expirationTime": <unix>,
       "monitoringExpiration": <unix>,
       "currency": "USD",
       "metadata": {"cardId": "...", "orderId": "...", "type": "topUp", "topupValue": "5"},
       "checkout": {
         "paymentMethods": ["BTC-LN", "BTC-CHAIN", "BTC-LNURL", "XMR-CHAIN"],
         "defaultPaymentMethod": "BTC-LN",
         "expirationMinutes": 90, "monitoringMinutes": 90,
         "paymentTolerance": 0,
         "redirectURL": "https://2fiat.com/api/v1/invoice-return/<uuid>",
         "redirectAutomatically": true
       },
       "receipt": {"enabled": false, "showQR": true, "showPayments": true},
       "redirectLink": "https://2fiat.com/api/v1/invoice-return/<uuid>"
     }
```

## What this settles

- **The top-up fee is 6.5%, confirmed arithmetically**: `topupValue: 5` →
  `amount: "5.33"`. Matches the product metadata's `topup_fee: 0.065`.
- **Lightning is the default rail** (`defaultPaymentMethod: "BTC-LN"`), which is
  exactly what our NUT-05 melt can pay.
- The bolt11 is **not** in this response. It lives behind the checkout
  (`/pay/i/<id>`, a BTCPay-style page, with a `/api/v1/invoice-return/<uuid>`
  callback). Obtain it from the checkout page/API before melting.
- `availableStatusesForManualMarking: ["Settled", "Invalid"]` — an operator can
  manually mark one, which is a useful escape hatch for a stuck payment.

## What the wallet's transaction history revealed

The card's own `vccTransactions` show genuine online merchant attempts:

```
OLLAMA TORONTO   -20.00 USD  FAILED
CHUTESAI WILMINGTON  -10.00 USD  FAILED
```

**The card IS used for online card payments** — the merchants requested
authorization. Every attempt FAILED, and the card balances are $0.38 / $0.10, so
the cause is insufficient balance, not a missing capability. That is the single
most encouraging finding here: topping the card up should make card payments
actually go through.

## Economics of one venue payment (measured fee, operator's 21% margin)

| Leg | Amount (on a 10.00 EUR venue bill) |
|---|---|
| Customer pays | 12.10 EUR in sats (10.00 + 21% fee) |
| Melted to fund the top-up | 10.00 EUR-equivalent |
| 2fiat top-up fee (6.5%) | 0.65 EUR |
| Lands on the card | 10.00 EUR |
| **Operator keeps** | **1.45 EUR (14.5%)** |

## Safety note for anyone re-running the recon

- The two endpoints above **create a payment order but move no money**. Nothing
  in the recon confirms a purchase, buys a card, or pays.
- The recon scripts NEVER click anything matching
  `confirm|buy now|purchase|pay now|place order|submit payment`.
- **Do not burst requests at 2fiat.** A rapid probe burst (≈35 endpoints) twice
  tripped their shared edge limiter, after which TCP 443 timed out from BOTH
  x280 and testserver2. One browser session with human-like pacing is fine; a
  scripted sweep is not.

## Scripts

- `tools/2fiat_ui_recon.py` — map the wallet UI + record API calls
- `tools/2fiat_topup_recon.py` — open a card, reveal the rail selector
- `tools/2fiat_topup_quote.py` — fill an amount, pick BTC LN, capture the top-up
  POST and its RESPONSE (the contract above)
