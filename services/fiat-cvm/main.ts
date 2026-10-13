/**
 * Entry point for the 2fiat CVM (ADR-0016).
 *
 * Reads its signing key from SERVER_HEX (exported by run-fiat-server.sh from the
 * key file, so the secret never sits in argv), then serves until signalled.
 */

import { serve } from "./server.ts";

const hex = Deno.env.get("SERVER_HEX");
if (!hex) {
  console.error("[fiat-cvm] SERVER_HEX env var is required");
  Deno.exit(1);
}

const relays = (Deno.env.get("FIAT_SERVER_RELAYS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const payAllowlist = (Deno.env.get("FIAT_PAY_ALLOWLIST") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const stop = await serve({
  serverHex: hex,
  relays: relays.length ? relays : undefined,
  payAllowlist,
  log: (m) => console.log(m),
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, () => {
    console.log(`[fiat-cvm] ${sig} received, shutting down`);
    stop();
    Deno.exit(0);
  });
}

// Keep the process alive while the relays are subscribed.
await new Promise(() => {});
