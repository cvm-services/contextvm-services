/**
 * Order flow — connects "customer paid" to "venue confirmed", and decides what
 * happens when those two disagree.
 *
 * The money rule this file exists to enforce:
 *
 *   Refunding is only safe when we KNOW the venue did not take the order.
 *   When the venue's outcome is unknown, refunding may pay the customer back AND
 *   still have food arriving — a double loss. So `unknown` never refunds, and it
 *   never retries; it stops and asks a human.
 *
 * The other rule: a captcha is not a failure. `requires_human` means the order is
 * alive and parked, waiting for a facilitator — refunding there would cancel a
 * perfectly good order because nobody had solved a puzzle yet.
 */

import type { Settlement } from "./settlement.ts";

export type VenueOutcome =
  | { status: "confirmed"; ref: string }
  | { status: "requires_human"; session_id: string }
  | { status: "failed"; reason: string }
  | { status: "unknown"; reason?: string };

export interface VenueRail {
  /** Places the order at the venue with the funded card. Never charges sats. */
  checkout(input: { order_id: string; sats: number }): Promise<VenueOutcome>;
}

export interface RefundRail {
  /** Returns the customer's sats. Must be idempotent per order. */
  refund(order_id: string, reason: string): Promise<{ ref: string }>;
}

export type FlowState =
  | "awaiting_payment"
  | "awaiting_venue_human"
  | "confirmed"
  | "refunded"
  | "venue_failed"
  | "outcome_unknown";

export interface FlowResult {
  order_id: string;
  state: FlowState;
  venue_ref?: string;
  refund_ref?: string;
  session_id?: string;
  reason?: string;
}

export class OrderFlow {
  #placements = new Map<string, number>(); // order_id -> checkout count
  #results = new Map<string, FlowResult>();

  constructor(
    private settlement: Settlement,
    private venue: VenueRail,
    private refunds: RefundRail,
  ) {}

  /** Status without side effects. */
  status(orderId: string): FlowResult {
    return this.#results.get(orderId) ?? { order_id: orderId, state: "awaiting_payment" };
  }

  /**
   * Place the venue order once the payment has settled.
   *
   * Idempotent per order: calling it twice must not place two orders at the
   * venue, because the customer would be charged once and fed twice (or, worse,
   * the venue would reject the duplicate and we would refund a real order).
   */
  async placeOrder(orderId: string): Promise<FlowResult> {
    const done = this.#results.get(orderId);
    if (done && done.state !== "awaiting_venue_human") return done;

    const o = this.settlement.get(orderId);
    if (o.state !== "paid") {
      // Nothing to place. If the payment is unresolved, that is the blocker -
      // not the venue - and saying so prevents a refund from being tried here.
      const state: FlowState = o.state === "outcome_unknown" ? "outcome_unknown" : "awaiting_payment";
      const r: FlowResult = { order_id: orderId, state, reason: `payment is ${o.state}` };
      this.#results.set(orderId, r);
      return r;
    }

    if ((this.#placements.get(orderId) ?? 0) > 0 && done?.state === "outcome_unknown") {
      // An unknown venue outcome must be resolved by a human, never by trying again.
      return done;
    }
    this.#placements.set(orderId, (this.#placements.get(orderId) ?? 0) + 1);

    let outcome: VenueOutcome;
    try {
      outcome = await this.venue.checkout({ order_id: orderId, sats: o.sats });
    } catch (e) {
      // The venue call threw. We do not know whether the order exists.
      outcome = { status: "unknown", reason: String((e as Error)?.message ?? e) };
    }

    switch (outcome.status) {
      case "confirmed": {
        this.settlement.confirm(orderId, outcome.ref);
        const r: FlowResult = { order_id: orderId, state: "confirmed", venue_ref: outcome.ref };
        this.#results.set(orderId, r);
        return r;
      }

      case "requires_human": {
        // Alive and parked. No refund, no retry, no confirm.
        const r: FlowResult = {
          order_id: orderId,
          state: "awaiting_venue_human",
          session_id: outcome.session_id,
          reason: "a facilitator must solve the venue captcha",
        };
        this.#results.set(orderId, r);
        return r;
      }

      case "failed": {
        // We know the venue did not take the order: make the customer whole.
        const { ref } = await this.refunds.refund(orderId, `venue failed: ${outcome.reason}`);
        this.settlement.refund(orderId, `venue failed: ${outcome.reason}`, ref);
        const r: FlowResult = {
          order_id: orderId,
          state: "refunded",
          refund_ref: ref,
          reason: outcome.reason,
        };
        this.#results.set(orderId, r);
        return r;
      }

      case "unknown": {
        // Deliberately no refund: the order may exist. Refunding here can pay the
        // customer back while the food still arrives - a double loss.
        const r: FlowResult = {
          order_id: orderId,
          state: "outcome_unknown",
          reason: outcome.reason ?? "venue did not report an outcome",
        };
        this.#results.set(orderId, r);
        return r;
      }
    }
  }

  /**
   * A facilitator solved the captcha and the venue has now accepted the order.
   * Separate method because confirmation arrives from the browser session, not
   * from the object that started the checkout.
   */
  async venueAccepted(orderId: string, venueRef: string): Promise<FlowResult> {
    this.settlement.confirm(orderId, venueRef);
    const r: FlowResult = { order_id: orderId, state: "confirmed", venue_ref: venueRef };
    this.#results.set(orderId, r);
    return r;
  }

  /**
   * The venue session died after payment without an answer. Still not a reason to
   * refund blind: a human checks whether the order exists, then calls
   * `resolveUnknown` with the truth.
   */
  async resolveUnknown(orderId: string, exists: boolean, detail: string): Promise<FlowResult> {
    const cur = this.#results.get(orderId);
    if (cur?.state !== "outcome_unknown") {
      throw new Error(`order ${orderId} is not in outcome_unknown (is ${cur?.state ?? "unset"})`);
    }
    if (exists) {
      this.settlement.confirm(orderId, detail);
      const r: FlowResult = { order_id: orderId, state: "confirmed", venue_ref: detail };
      this.#results.set(orderId, r);
      return r;
    }
    const { ref } = await this.refunds.refund(orderId, `resolved: ${detail}`);
    this.settlement.refund(orderId, `resolved: ${detail}`, ref);
    const r: FlowResult = { order_id: orderId, state: "refunded", refund_ref: ref, reason: detail };
    this.#results.set(orderId, r);
    return r;
  }
}
