/**
 * VenueRail over the Playwright harness process.
 *
 * The harness drives a real browser through a real checkout and prints one JSON
 * step per line. This adapter turns that stream into a VenueOutcome — and the
 * whole file exists because of one distinction:
 *
 *   NO CONFIRMATION IS NOT FAILURE. It is `unknown`.
 *
 * A crashed browser, a closed pipe, a step that never printed — none of these
 * prove the venue did not take the order. Reporting `failed` for them would
 * refund a customer whose food is on its way, which is a loss twice over. Only
 * two things may produce `failed`: the harness explicitly aborted before
 * submitting, or the venue explicitly refused.
 */

import type { VenueOutcome, VenueRail } from "./order_flow.ts";

export interface HarnessStep {
  step: string;
  [k: string]: unknown;
}

export interface HarnessRun {
  exit_code: number | null;
  steps: HarnessStep[];
  /** Set when the process could not be run at all. */
  error?: string;
}

export interface HarnessRequest {
  order_id: string;
  sats: number;
}

/** Injected: tests never spawn a browser. */
export interface HarnessSpawner {
  run(req: HarnessRequest): Promise<HarnessRun>;
}

/**
 * Exit codes the harness is documented to use.
 *   0  completed and reported
 *   10 aborted before submitting anything to the venue
 *   11 aborted by a safety guard (e.g. wrong phone destination)
 */
const EXIT_ABORT = 10;
const EXIT_GUARD = 11;

export class ProcessVenueRail implements VenueRail {
  constructor(private spawner: HarnessSpawner) {}

  async checkout({ order_id, sats }: { order_id: string; sats: number }): Promise<VenueOutcome> {
    let run: HarnessRun;
    try {
      run = await this.spawner.run({ order_id, sats });
    } catch (e) {
      return { status: "unknown", reason: `harness could not run: ${String((e as Error)?.message ?? e)}` };
    }
    return interpret(run);
  }
}

/**
 * Pure, so the rules can be tested without a browser. Order matters: positive
 * evidence of success beats everything; positive evidence of refusal beats
 * silence; everything else is unknown.
 */
export function interpret(run: HarnessRun): VenueOutcome {
  const steps = run.steps ?? [];

  // 1. Positive evidence the venue accepted the order.
  const confirmed = [...steps].reverse().find((s) => s.step === "venue_confirmed");
  if (confirmed) {
    const ref = typeof confirmed.ref === "string" && confirmed.ref.trim() ? confirmed.ref : "";
    if (ref) return { status: "confirmed", ref };
    // Confirmation with no reference is not confirmation we can act on.
    return { status: "unknown", reason: "venue_confirmed step carried no reference" };
  }

  // 2. A human is needed: alive, parked, and definitely not refundable.
  const holding = [...steps].reverse().find((s) => s.step === "holding_for_human");
  if (holding) {
    const sid = typeof holding.session_id === "string" ? holding.session_id : "";
    return {
      status: "requires_human",
      session_id: sid || (typeof holding.session === "string" ? holding.session : "unknown"),
    };
  }

  // 3. Positive evidence of refusal, before anything was submitted.
  const abort = [...steps].reverse().find((s) => s.step === "ABORT");
  if (abort) {
    const code = typeof abort.code === "string" ? abort.code : "aborted";
    return { status: "failed", reason: `harness aborted: ${code}` };
  }
  if (run.exit_code === EXIT_GUARD) {
    return { status: "failed", reason: "harness refused by its own safety guard" };
  }
  if (run.exit_code === EXIT_ABORT) {
    return { status: "failed", reason: "harness aborted before submitting the order" };
  }

  // 4. Everything else: we do not know. Crashes, timeouts, silent exits, a
  // missing pipe. Never "failed" — the order may exist.
  const last = steps.length ? steps[steps.length - 1].step : "no steps";
  const why = run.error ? run.error : `no confirmation; last step was ${last}; exit=${run.exit_code}`;
  return { status: "unknown", reason: why };
}
