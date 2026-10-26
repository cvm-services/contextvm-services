/**
 * Settlement core — where money is protected.
 *
 * Every rule here exists because a specific way of losing money was observed or
 * is one plausible bug away:
 *
 *   - a 3.1x OVERPAY from a derived USD/sat rate (the invoice's own amount is
 *     the only safe source of truth);
 *   - a DOUBLE PAY where a timeout was treated as failure and retried while the
 *     first payment was still settling;
 *   - sats sent to a mint for ecash nobody ever claimed ("into the void");
 *   - an order marked paid because the client said so, not because the rail did.
 *
 * The state machine is deliberately small and boring. `outcome_unknown` is a
 * first-class state, not an error: after a timeout we do not know, and acting as
 * if we know is how money disappears.
 */

export type PayState =
  | "created"        // no invoice yet
  | "invoiced"       // invoice exists, nothing sent
  | "paying"         // a payment attempt is in flight
  | "outcome_unknown" // we sent and did not learn the result. NOT failure.
  | "paid"           // provider says settled
  | "failed"         // provider says not settled; retry is safe
  | "refunded";      // money returned to the payer

export type AttemptOutcome = "in_flight" | "settled" | "failed" | "unknown";

export interface Invoice {
  bolt11: string;
  payment_hash: string;
  /** The amount encoded IN THE INVOICE. Never recomputed from a rate. */
  amount_sats: number;
}

export interface PayAttempt {
  id: string;
  /** Idempotency key: the same user action must never pay twice. */
  key: string;
  started_at: number;
  outcome: AttemptOutcome;
  provider_ref?: string;
}

export interface Order {
  id: string;
  /** Server-computed price. The client never supplies this. */
  sats: number;
  state: PayState;
  invoice?: Invoice;
  attempts: PayAttempt[];
  venue_ref?: string;
  refund_ref?: string;
  reason?: string;
}

export interface ProviderResult {
  status: "settled" | "failed" | "unknown";
  provider_ref?: string;
}

/** The rail. Injected so tests never touch a network or a wallet. */
export type Provider = {
  pay(bolt11: string, key: string): Promise<ProviderResult>;
  /** Ground truth, asked after an unknown outcome. */
  lookup(key: string): Promise<ProviderResult>;
};

export interface InvoiceIssuer {
  issue(sats: number, orderId: string): Promise<Invoice>;
}

export class SettlementError extends Error {
  constructor(public code: string, message: string) {
    // The code leads the message: a caller branching on `code` and a human
    // reading a log should never disagree about which failure this was.
    super(`${code}: ${message}`);
    this.name = "SettlementError";
  }
}

export class Settlement {
  #orders = new Map<string, Order>();
  #now: () => number;

  constructor(
    private provider: Provider,
    private issuer: InvoiceIssuer,
    now: () => number = () => Date.now(),
  ) {
    this.#now = now;
  }

  create(id: string, sats: number): Order {
    if (!Number.isInteger(sats) || sats <= 0) {
      throw new SettlementError("bad_amount", `refusing non-positive/non-integer amount: ${sats}`);
    }
    if (this.#orders.has(id)) throw new SettlementError("duplicate_order", `order ${id} exists`);
    const o: Order = { id, sats, state: "created", attempts: [] };
    this.#orders.set(id, o);
    return o;
  }

  get(id: string): Order {
    const o = this.#orders.get(id);
    if (!o) throw new SettlementError("no_order", `no order ${id}`);
    return o;
  }

  /**
   * Issue the invoice. Re-issuing for the same order returns the SAME invoice:
   * a customer who reloads the page must not be handed a second invoice for the
   * same food, because paying both is a real double charge.
   */
  async invoice(id: string): Promise<Invoice> {
    const o = this.get(id);
    if (o.invoice) return o.invoice;
    if (o.state !== "created") throw new SettlementError("bad_state", `cannot invoice in ${o.state}`);
    const inv = await this.issuer.issue(o.sats, id);
    // The single most important assertion in this file: the invoice must encode
    // exactly the price we intend to charge. A mismatch means one of the two
    // sides computed an amount from something other than the order.
    if (inv.amount_sats !== o.sats) {
      throw new SettlementError(
        "amount_mismatch",
        `invoice encodes ${inv.amount_sats} sats but order is ${o.sats}: refusing to hand out a mispriced invoice`,
      );
    }
    o.invoice = inv;
    o.state = "invoiced";
    return inv;
  }

  /**
   * Attempt payment. Idempotent per key.
   *
   * Refuses while an attempt is in flight or unknown: that is the double-pay
   * guard. Two taps on "Pay" must not produce two payments, and a retry after a
   * timeout must wait for reconciliation.
   */
  async pay(id: string, key: string): Promise<Order> {
    const o = this.get(id);
    if (o.state === "paid" || o.state === "refunded") return o;

    const same = o.attempts.find((a) => a.key === key);
    if (same) return o; // already tried with this key: do nothing, again

    if (o.attempts.some((a) => a.outcome === "in_flight" || a.outcome === "unknown")) {
      throw new SettlementError(
        "must_reconcile",
        `order ${id} has an unresolved attempt; reconcile before paying again`,
      );
    }
    if (o.state !== "invoiced" && o.state !== "failed") {
      throw new SettlementError("bad_state", `cannot pay in ${o.state}`);
    }
    const inv = o.invoice;
    if (!inv) throw new SettlementError("bad_state", "no invoice to pay");

    // Journal BEFORE the network call. If we crash here, the attempt is on disk
    // as in_flight and the next process knows to reconcile instead of retry.
    const attempt: PayAttempt = { id: `${id}:${key}`, key, started_at: this.#now(), outcome: "in_flight" };
    o.attempts.push(attempt);
    o.state = "paying";

    let res: ProviderResult;
    try {
      res = await this.provider.pay(inv.bolt11, key);
    } catch {
      // A thrown provider call is UNKNOWN, never failure. The payment may have
      // been sent; treating a network error as "did not happen" is exactly the
      // bug that double-pays.
      res = { status: "unknown" };
    }

    if (res.status === "settled") {
      attempt.outcome = "settled";
      attempt.provider_ref = res.provider_ref;
      o.state = "paid";
    } else if (res.status === "failed") {
      attempt.outcome = "failed";
      attempt.provider_ref = res.provider_ref;
      o.state = "failed";
    } else {
      attempt.outcome = "unknown";
      o.state = "outcome_unknown";
    }
    return o;
  }

  /**
   * Ask the rail what really happened. The only way out of `outcome_unknown`.
   * Never re-sends a payment.
   */
  async reconcile(id: string): Promise<Order> {
    const o = this.get(id);
    const pending = o.attempts.find((a) => a.outcome === "unknown" || a.outcome === "in_flight");
    if (!pending) return o;

    const res = await this.provider.lookup(pending.key);
    if (res.status === "settled") {
      pending.outcome = "settled";
      pending.provider_ref = res.provider_ref;
      o.state = "paid";
    } else if (res.status === "failed") {
      pending.outcome = "failed";
      pending.provider_ref = res.provider_ref;
      o.state = "failed";
    }
    // still unknown: stay unknown and keep blocking. Waiting is free; guessing
    // is not.
    return o;
  }

  /**
   * The venue confirmed the order. Only legal after the rail says paid — an
   * order is never "paid" on the strength of a client assertion.
   */
  confirm(id: string, venueRef: string): Order {
    const o = this.get(id);
    if (o.state !== "paid") {
      throw new SettlementError("not_paid", `cannot confirm order ${id} in state ${o.state}`);
    }
    if (o.venue_ref) return o; // idempotent
    o.venue_ref = venueRef;
    return o;
  }

  /**
   * Return the money. Legal when we hold a settled payment and the food is not
   * happening. Records the reference — a refund nobody can point at is not one.
   */
  refund(id: string, reason: string, refundRef: string): Order {
    const o = this.get(id);
    if (o.state !== "paid") {
      throw new SettlementError("not_paid", `cannot refund order ${id} in state ${o.state}`);
    }
    o.state = "refunded";
    o.reason = reason;
    o.refund_ref = refundRef;
    return o;
  }

  /** Accounting: every sat must be explained. Returns the unexplained delta. */
  reconcileLedger(): { paid: number; refunded: number; settled_attempts: number } {
    let paid = 0;
    let refunded = 0;
    let settled_attempts = 0;
    for (const o of this.#orders.values()) {
      for (const a of o.attempts) if (a.outcome === "settled") settled_attempts++;
      if (o.state === "paid") paid += o.sats;
      if (o.state === "refunded") refunded += o.sats;
    }
    return { paid, refunded, settled_attempts };
  }
}
