import { describe, expect, test } from "bun:test";
import { assertRailAllowed, classifyRail, isEvidenceBearing, RailRefused } from "./rail_guard.ts";

const TESTNUT = "https://testnut.cashu.exchange";

describe("classification", () => {
  test("testnut is a fake mint", () => {
    expect(classifyRail(TESTNUT)).toBe("fake_mint");
    expect(classifyRail("https://testnut.cashu.exchange/v1/info")).toBe("fake_mint");
  });
  test("loopback variants", () => {
    expect(classifyRail("http://127.0.0.1:3000")).toBe("loopback");
    expect(classifyRail("http://localhost:3338")).toBe("loopback");
    expect(classifyRail("http://[::1]:3338")).toBe("loopback");
  });
  test("a real mint is production", () => {
    expect(classifyRail("https://mint.minibits.cash/Bitcoin")).toBe("production");
  });
  test("garbage is unknown", () => {
    expect(classifyRail("not a url")).toBe("unknown");
  });
});

describe("a fake mint can never take a real payment", () => {
  test("payment on testnut is refused, with the reason stated", () => {
    expect(() => assertRailAllowed(TESTNUT, "payment")).toThrow(RailRefused);
    try {
      assertRailAllowed(TESTNUT, "payment");
    } catch (e) {
      expect(String((e as Error).message)).toContain("marks every invoice paid");
    }
  });

  test("ecash mechanics may use testnut — its value is worthless by design", () => {
    expect(() => assertRailAllowed(TESTNUT, "ecash_mechanics")).not.toThrow();
  });

  test("test may use testnut", () => {
    expect(() => assertRailAllowed(TESTNUT, "test")).not.toThrow();
  });
});

describe("other refusals", () => {
  test("payment against loopback is refused", () => {
    expect(() => assertRailAllowed("http://127.0.0.1:3338", "payment")).toThrow(/loopback/);
  });
  test("production must be https", () => {
    expect(() => assertRailAllowed("http://mint.example.com", "payment")).toThrow(/https/);
    expect(() => assertRailAllowed("https://mint.example.com", "payment")).not.toThrow();
  });
  test("an empty or unparseable url is refused", () => {
    expect(() => assertRailAllowed("", "payment")).toThrow(/no_url/);
    expect(() => assertRailAllowed("nope", "payment")).toThrow(/unparseable/);
  });
});

describe("evidence", () => {
  test("only a production rail may be cited as proof about real money", () => {
    expect(isEvidenceBearing("https://mint.minibits.cash/Bitcoin")).toBe(true);
    expect(isEvidenceBearing(TESTNUT)).toBe(false);
    expect(isEvidenceBearing("http://127.0.0.1:3338")).toBe(false);
  });
});
