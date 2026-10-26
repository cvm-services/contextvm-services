import { describe, expect, test } from "bun:test";
import { applyWalletTruth, classifyEntry, isValidPreimage, summarise, type JournalEntry } from "./journal_reconcile.ts";

const BOLT11 = "lnbc40n1p4dfeg4pp5kw68znxetgr36d33entwxyz".padEnd(258, "0");
const PRE = "a".repeat(64);

const entry = (o: Partial<JournalEntry>): JournalEntry => ({
  amountSats: 4, bolt11: BOLT11, state: "paying", ...o,
});

describe("preimage validity", () => {
  test("64 hex chars is a preimage; anything else is not", () => {
    expect(isValidPreimage(PRE)).toBe(true);
    expect(isValidPreimage(PRE.toUpperCase())).toBe(true);
    expect(isValidPreimage("a".repeat(21))).toBe(false); // the real defect found
    expect(isValidPreimage("a".repeat(63))).toBe(false);
    expect(isValidPreimage("")).toBe(false);
    expect(isValidPreimage(undefined)).toBe(false);
  });
});

describe("classification", () => {
  test("a valid preimage settles an entry", () => {
    const c = classifyEntry(entry({ state: "claimed", preimage: PRE }));
    expect(c.kind).toBe("settled");
  });

  test("claimed with a malformed preimage is an UNVERIFIED claim, not settled", () => {
    const c = classifyEntry(entry({ state: "claimed", preimage: "a".repeat(21) }));
    expect(c.kind).toBe("unverified_claim");
    expect(c.reason).toContain("21 chars");
  });

  test("claimed with no preimage at all is unverified", () => {
    expect(classifyEntry(entry({ state: "claimed" })).kind).toBe("unverified_claim");
  });

  test("stuck in paying is unknown, never failed", () => {
    const c = classifyEntry(entry({ state: "paying" }));
    expect(c.kind).toBe("unknown");
    // "failed" here would invite a retry of a payment that may have gone through.
    expect(c.kind).not.toBe("failed");
  });

  test("an entry with no invoice is malformed", () => {
    expect(classifyEntry(entry({ bolt11: "" })).kind).toBe("malformed");
    expect(classifyEntry(entry({ bolt11: "lnbc1short" })).kind).toBe("malformed");
  });

  test("classification never echoes the preimage", () => {
    const c = classifyEntry(entry({ state: "claimed", preimage: PRE }));
    expect(JSON.stringify(c)).not.toContain(PRE);
  });
});

describe("summary", () => {
  test("separates proven sats from unproven, and never calls it clean", () => {
    const s = summarise([
      entry({ state: "claimed", preimage: PRE, amountSats: 8 }),
      entry({ state: "paying", amountSats: 4 }),
      entry({ state: "claimed", preimage: "a".repeat(21), amountSats: 4 }),
    ]);
    expect(s.settled_sats).toBe(8);
    expect(s.unknown_sats).toBe(4);
    expect(s.unverified_sats).toBe(4);
    expect(s.clean).toBe(false);
    expect(s.needs_wallet_lookup.length).toBe(2);
  });

  test("all-proven journal is clean", () => {
    const s = summarise([entry({ state: "claimed", preimage: PRE })]);
    expect(s.clean).toBe(true);
    expect(s.needs_wallet_lookup.length).toBe(0);
  });
});

describe("applying wallet truth", () => {
  test("settled without a preimage is recorded as unverified, not trusted", () => {
    const e = applyWalletTruth(entry({}), "settled");
    expect(e.state).toBe("settled_unverified");
  });

  test("settled with a preimage is recorded properly", () => {
    const e = applyWalletTruth(entry({}), "settled", PRE);
    expect(e.state).toBe("settled");
    expect(e.preimage).toBe(PRE);
  });

  test("still unknown stays unknown; failed is recorded as failed", () => {
    expect(applyWalletTruth(entry({}), "unknown").state).toBe("outcome_unknown");
    expect(applyWalletTruth(entry({}), "failed").state).toBe("failed");
  });

  test("original entry is not mutated", () => {
    const e = entry({ state: "paying" });
    applyWalletTruth(e, "failed");
    expect(e.state).toBe("paying");
  });
});
