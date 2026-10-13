# 2fiat.com — API surface (measured 2026-10-13)

Discovered by driving a real wallet with Playwright against
`https://2fiat.com/wallet/<token>/my-cards`. Values redacted; endpoints and
shapes are verbatim from observed network traffic.

## The edge drops non-browser clients (READ THIS FIRST)

`curl` with a default User-Agent gets `curl: (52) Empty reply from server`
(HTTP 000) on **every** API path, while the same request with a browser
User-Agent returns a normal response. The app also sends the header
`ngrok-skip-browser-warning: 5000`. Any CVM client MUST send a browser-like
User-Agent or it will look like the API is down when it is not.

Observed:

- browser User-Agent → `GET /api/v1/` → `200 {}`
- default User-Agent → `GET /api/v1/` → connection closed, no response

## Base and auth

- **base** — `https://2fiat.com/api/v1/` (from `NEXT_PUBLIC_API_URL`, same origin)
- **session** — `POST auth/exchange` with body `{token, nextPath}`; the response
  sets a session cookie (the app sends `withCredentials`)
- **logout** — `POST auth/logout`
- **login link** — `GET auth/login-link` → path back to the wallet page
- **token format** — a `token1…` string, the login token of an EXISTING wallet
- **required headers** — `Content-Type: application/json`,
  `ngrok-skip-browser-warning: 5000`, and a browser User-Agent
- **401 behaviour** — the app redirects the browser to `/cards`

## Read endpoints (observed 200 with a live session)

- **`GET cards`** — the wallet's cards. Each entry carries an id, balance,
  currency, a masked card number (first four and last four only), expiry, an
  alias, the payment type, and a cardProduct object whose metadata includes
  topup fee, whether KYC is required, and the starting deposit.
- **`GET prepaid-cards/details/{id}`** — fuller card detail: product code, the
  provider-side card id, created/updated timestamps.
- **`GET vccTransactions`** with query params skip, take, dateFrom, dateTo,
  cardId — transaction rows: amount, currency, merchant description, status,
  type (for example AUTHORIZATION).
- **`GET user`** — account record: username, role, address.
- **`GET btc-currencies`** — **top-up rails, and this list includes `BTC LN`
  (Lightning)**, plus XMR and BTC.
- **`GET alerts/active`**, **`GET livechat/chat-id`** — misc app data.

## Sensitive-material endpoints (exist; NOT exercised here)

`GET prepaid-cards/reveal/{id}`, `GET prepaid-cards/{id}/cvv`,
`GET cards/{id}/details` return full card number and CVV. **The CVM must never
log, persist, or return them.** Only the last-four value already present in
`GET cards` is safe to relay to a console.

## Economics observed on the real card product

- topup fee `0.065` → **6.5% top-up fee**, from the product metadata and
  consistent with the marketing copy
- starting deposit 20, no KYC required, validity period 12 months
- card balances seen on the live wallet: 0.38 USD and 0.30 USD

## Design consequence for the CVM

Card payments on this product are **3D Secure enabled**. A fully unattended
`pay` therefore cannot be guaranteed — the honest tool contract is:

- **`cards`** — list cards and balances (read-only)
- **`quote`** — resolve which card, the fiat amount, and the fee-inclusive total
- **`pay`** — attempt the fiat payment; **may return a 3DS challenge** and hand
  the human the approval URL. Never claim success it did not observe.
- **`status`** — poll the recorded reference

The CVM never returns PAN or CVV and never stores them.
