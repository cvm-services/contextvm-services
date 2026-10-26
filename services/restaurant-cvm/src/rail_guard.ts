/**
 * Rail guard — refuses to spend real sats against a rail that cannot honour them.
 *
 * WHY THIS EXISTS
 * `testnut.cashu.exchange` states in its own `/v1/info` that all Lightning
 * invoices are ALWAYS marked paid. That makes it useful for exercising ecash
 * mechanics and actively dangerous as a payment target:
 *
 *   - paying a testnut invoice sends real sats to a test mint and buys nothing.
 *     That is the definition of money into the void.
 *   - using it as a settlement source makes every test pass vacuously: the rail
 *     says "paid" whether or not anything was paid, so a green suite proves
 *     nothing about the real rail.
 *
 * So "use testnut so money is not wasted" is right about the goal and backwards
 * about the mechanism. The way to not waste money is to not spend it: stub rails
 * for automated tests, and a regtest node when real protocol behaviour is needed.
 * This guard makes that structural instead of a convention someone remembers.
 */

export type RailPurpose =
  /** Moving real value. The only purpose that may ever touch production. */
  | "payment"
  /** Mint/melt mechanics where a worthless mint is acceptable. */
  | "ecash_mechanics"
  /** Local development. Loopback only. */
  | "test";

export type RailKind = "fake_mint" | "loopback" | "production" | "unknown";

export class RailRefused extends Error {
  constructor(public reason: string, message: string) {
    super(`${reason}: ${message}`);
    this.name = "RailRefused";
  }
}

/** Hosts that advertise themselves as test/fake rails. Substring match on host. */
const FAKE_HOST_MARKERS = ["testnut", "test-mint", "fake-mint", "mock-mint"];

export function classifyRail(url: string): RailKind {
  let host: string;
  try {
    // `hostname` keeps the brackets on an IPv6 literal ("[::1]"), so an
    // un-stripped comparison silently classifies loopback as production.
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "unknown";
  }
  if (FAKE_HOST_MARKERS.some((m) => host.includes(m))) return "fake_mint";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
    return "loopback";
  }
  return "production";
}

/**
 * Throws unless this rail may be used for this purpose. Deliberately strict:
 * there is no flag that lets a fake mint take a real payment.
 */
export function assertRailAllowed(url: string, purpose: RailPurpose): void {
  if (!url || !url.trim()) {
    throw new RailRefused("no_url", "a rail url is required");
  }
  const kind = classifyRail(url);
  const protocol = (() => {
    try {
      return new URL(url).protocol;
    } catch {
      return "";
    }
  })();

  if (kind === "unknown") {
    throw new RailRefused("unparseable", `not a url: ${url.slice(0, 40)}`);
  }

  if (kind === "fake_mint") {
    if (purpose === "payment") {
      throw new RailRefused(
        "fake_mint",
        "this mint marks every invoice paid; paying it sends sats nowhere and " +
          "makes any settlement test pass vacuously. Use a stub or regtest for payments.",
      );
    }
    // ecash_mechanics and test may use it - the value is worthless by design and
    // nothing downstream may treat a result as evidence about the real rail.
    return;
  }

  if (kind === "loopback") {
    if (purpose === "payment") {
      throw new RailRefused(
        "loopback_payment",
        "a real payment must not point at loopback; that is a test rail with a production label",
      );
    }
    return;
  }

  // production
  if (protocol !== "https:") {
    throw new RailRefused("insecure", `production rail must be https, got ${protocol || "none"}`);
  }
}

/** True when a result from this rail may be cited as evidence about real money. */
export function isEvidenceBearing(url: string): boolean {
  return classifyRail(url) === "production";
}
