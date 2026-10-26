/**
 * The classification rules for a harness run. The important ones are the
 * SILENCE cases: everything that is not positive evidence of refusal must be
 * `unknown`, because refunding an order that exists loses twice.
 */
import { describe, expect, test } from "bun:test";
import { interpret, ProcessVenueRail, type HarnessRun, type HarnessSpawner } from "./venue_process_rail.ts";

const run = (steps: string[], exit_code: number | null = 0, error?: string): HarnessRun => ({
  exit_code,
  steps: steps.map((s) => (s.includes(":") ? { step: s.split(":")[0], ref: s.split(":")[1] } : { step: s })),
  error,
});

describe("confirmation", () => {
  test("an explicit venue reference is confirmed", () => {
    const o = interpret(run(["cart_badge", "kaufen_clicked", "venue_confirmed:TG-8842"]));
    expect(o).toEqual({ status: "confirmed", ref: "TG-8842" });
  });

  test("confirmation without a reference is unknown, not confirmed", () => {
    const o = interpret(run(["venue_confirmed"]));
    expect(o.status).toBe("unknown");
  });
});

describe("human required", () => {
  test("holding for a captcha is requires_human, never failure", () => {
    const o = interpret({
      exit_code: null,
      steps: [{ step: "holding_for_human", session_id: "s_7" }],
    });
    expect(o).toEqual({ status: "requires_human", session_id: "s_7" });
  });

  test("holding wins over an earlier abort (the order is still alive)", () => {
    const o = interpret({
      exit_code: null,
      steps: [{ step: "ABORT", code: "x" }, { step: "holding_for_human", session_id: "s_8" }],
    });
    expect(o.status).toBe("requires_human");
  });
});

describe("refusal", () => {
  test("an explicit abort is failed", () => {
    const o = interpret({ exit_code: 10, steps: [{ step: "ABORT", code: "wrong-destination" }] });
    expect(o.status).toBe("failed");
    expect(String((o as { reason: string }).reason)).toContain("wrong-destination");
  });

  test("the safety-guard exit code is failed", () => {
    expect(interpret({ exit_code: 11, steps: [] }).status).toBe("failed");
  });

  test("the abort exit code is failed", () => {
    expect(interpret({ exit_code: 10, steps: [] }).status).toBe("failed");
  });
});

describe("silence is unknown, never failure", () => {
  test("a crash mid-flow is unknown", () => {
    const o = interpret({ exit_code: null, steps: [{ step: "kaufen_clicked" }], error: "chrome crashed" });
    expect(o.status).toBe("unknown");
  });

  test("exit 0 with no confirmation step is unknown", () => {
    const o = interpret(run(["cart_badge", "kaufen_clicked", "SMS_ARRIVED"], 0));
    expect(o.status).toBe("unknown");
  });

  test("an empty run is unknown", () => {
    expect(interpret({ exit_code: 0, steps: [] }).status).toBe("unknown");
  });

  test("a spawner that throws is unknown", async () => {
    const spawner: HarnessSpawner = { async run() { throw new Error("no chrome"); } };
    const rail = new ProcessVenueRail(spawner);
    const o = await rail.checkout({ order_id: "o1", sats: 1334 });
    expect(o.status).toBe("unknown");
  });

  test("no unknown case is ever classified as failed or confirmed", () => {
    for (const r of [
      { exit_code: 0, steps: [] },
      { exit_code: null, steps: [], error: "killed" },
      { exit_code: 0, steps: [{ step: "code_senden_clicked" }] },
    ] as HarnessRun[]) {
      const o = interpret(r);
      expect(o.status).toBe("unknown");
    }
  });
});

describe("checkout wiring", () => {
  test("the spawner receives the order and its sats", async () => {
    let seen: unknown;
    const spawner: HarnessSpawner = {
      async run(req) {
        seen = req;
        return run(["venue_confirmed:TG-1"]);
      },
    };
    const o = await new ProcessVenueRail(spawner).checkout({ order_id: "o9", sats: 4242 });
    expect(seen).toEqual({ order_id: "o9", sats: 4242 });
    expect(o.status).toBe("confirmed");
  });
});
