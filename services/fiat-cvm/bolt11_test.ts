// The invoice is the authority for its own amount.
//
// Written because a funding script converted USD->sats at a hardcoded rate
// implying BTC ~= $25,820 and would have paid 4,145 sats for a 1,334-sat invoice
// (BTC was ~$80,210). These cases pin the decoding AND the refusal paths, because
// a wrong number here spends real money.

import { describe, expect, test } from "bun:test";
import { bolt11Sats } from "./bolt11.ts";

describe("bolt11Sats", () => {
  // Real values measured from the provider on 2026-10-25.
  test("decodes the nano-bitcoin form the provider actually issues", () => {
    expect(bolt11Sats("lnbc13340n1p4dfeg4pp5kw68znxetgr36d33entwxyz")).toBe(1334);
  });

  test("decodes the other multiplier forms", () => {
    expect(bolt11Sats("lnbc1u1p4du9xupp5kz")).toBe(100);
    expect(bolt11Sats("lnbc25m1pxyz")).toBe(2_500_000);
    // 10 pico-BTC is BELOW one satoshi, so it must be refused, not rounded to 0 or 1.
    expect(() => bolt11Sats("lnbc10p1pxyz")).toThrow(/unreadable/i);
    expect(bolt11Sats("lnbc10000p1pxyz")).toBe(1);
    expect(bolt11Sats("lnbc1000n1pxyz")).toBe(100);
  });

  test("the old hardcoded rate would have paid 3x: this is the regression", () => {
    // 1.07 USD at the provider's quote vs at the stale constant.
    const correct = bolt11Sats("lnbc13340n1p4d");
    const stale = Math.ceil(1.07 / 0.00025820);
    expect(correct).toBe(1334);
    expect(stale).toBe(4145);
    expect(stale / correct).toBeGreaterThan(3);
  });

  test("an amountless invoice is an error, never a default", () => {
    // Callers pay FIXED invoices; inventing an amount here would spend money.
    expect(() => bolt11Sats("lnbc1p4dfeg4pp5kw")).toThrow(/fixed-amount/i);
  });

  test("a non-bitcoin or malformed prefix is refused", () => {
    expect(() => bolt11Sats("lntbs13340n1p4d")).toThrow(/fixed-amount/i);
    expect(() => bolt11Sats("lnbc13340n")).toThrow(/fixed-amount/i);
    expect(() => bolt11Sats("")).toThrow();
  });

  test("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(bolt11Sats("  LNBC13340N1P4DFEG4  ")).toBe(1334);
  });
});
