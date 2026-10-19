/**
 * Credential loader for the 2fiat CVM (ADR-0016 + ADR-020).
 *
 * Resolution order, and why:
 *   1. `TWO_FIAT_TOKEN` in the environment — this is how a systemd unit receives
 *      it (EnvironmentFile materialised from the vault).
 *   2. OpenBao, read with this node's AppRole, over the FIPS address, when the
 *      env is absent (dev / one-shot runs).
 *
 * The token is NEVER taken from argv and NEVER logged. Only its length and the
 * path it came from may be reported.
 */

export interface FiatSecretSource {
  source: "env" | "openbao";
  token: string;
}

const ENV_NAME = "TWO_FIAT_TOKEN";
const BAO_PATH = "/v1/secret/data/fleet/2fiat";

export interface LoadOptions {
  fetchImpl?: typeof fetch;
  env?: (name: string) => string | undefined;
  /** OpenBao address + creds; when omitted, read from ~/.hermes/openbao/env */
  baoAddr?: string;
  roleId?: string;
  secretId?: string;
  baoEnvFile?: string;
}

async function openBaoToken(opts: LoadOptions): Promise<string | null> {
  const env = opts.env ?? ((n: string) => Deno.env.get(n));
  const read = async (p: string) => {
    try {
      return (await Deno.readTextFile(p)).trim();
    } catch {
      return "";
    }
  };
  let addr = opts.baoAddr ?? env("OPENBAO_ADDR") ?? "";
  let roleId = opts.roleId ?? "";
  let secretId = opts.secretId ?? "";

  if (!roleId || !secretId) {
    // ~/.hermes/openbao/env declares OPENBAO_ADDR + the two credential FILES.
    const home = env("HOME") ?? "";
    const f = opts.baoEnvFile ?? `${home}/.hermes/openbao/env`;
    const text = await read(f);
    for (const raw of text.split("\n")) {
      // The fleet's file is valid SHELL: lines read `export NAME=value`. Accept
      // the optional `export ` prefix — without it the whole file parses to
      // nothing and the loader reports "no token" against a perfectly good vault.
      const line = raw.trim().replace(/^export\s+/, "");
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "OPENBAO_ADDR" && !addr) addr = value;
      if (m[1] === "OPENBAO_ROLE_ID_FILE") roleId ||= (await read(value));
      if (m[1] === "OPENBAO_SECRET_ID_FILE") secretId ||= (await read(value));
    }
  }
  if (!addr || !roleId || !secretId) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const login = await doFetch(`${addr}/v1/auth/approle/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
    });
    if (!login.ok) return null;
    const tok = (await login.json())?.auth?.client_token;
    if (!tok) return null;
    const res = await doFetch(`${addr}${BAO_PATH}`, { headers: { "X-Vault-Token": tok } });
    if (!res.ok) return null;
    const body = await res.json();
    // The stored field is `2fiat`; accept `token` too for forward compat.
    // Normalise: the field may hold a wallet URL rather than a bare token.
    const stored = body?.data?.data?.token ?? body?.data?.data?.["2fiat"] ?? null;
    return stored ? normaliseWalletToken(String(stored)) : null;
  } catch {
    return null;
  }
}

/**
 * Normalise whatever the vault holds into the bare wallet token.
 *
 * MEASURED 2026-10-19: the `2fiat` field holds a WALLET URL, not a token —
 *   https://2fiat.com/wallet/token1anz2skuq8pzf8x0w7302axmu4gjfdjmc/my-cards
 * The credential is the `token1...` path segment. Returning the URL verbatim made
 * every consumer send `Bearer https://...`, and 2fiat answered 401 Unauthorized —
 * which read as "auth refused" and sent us hunting the wrong problem.
 *
 * Accepts a bare token, a wallet URL (any host), or a token with stray slashes.
 * Never logs or echoes the value.
 */
export function normaliseWalletToken(raw: string): string {
  let v = raw.trim().replace(/^["']|["']$/g, "");
  if (!v) return v;
  // A URL: take the path segment that looks like the token.
  if (v.includes("://")) {
    try {
      const parts = new URL(v).pathname.split("/").filter(Boolean);
      // Prefer a segment that looks like a wallet token; else the longest one
      // after `wallet`, else the first.
      const tokenish = parts.find((p) => /^token[0-9a-z]{8,}$/i.test(p));
      if (tokenish) return tokenish;
      const i = parts.indexOf("wallet");
      if (i >= 0 && parts[i + 1]) return parts[i + 1];
      if (parts.length) return parts[parts.length - 1];
    } catch {
      // fall through to the slash-stripping path below
    }
  }
  // Defensive: a bare token should never contain a slash.
  const slash = v.split("/").filter(Boolean);
  if (slash.length > 1) return slash[slash.length - 1];
  return v;
}

/** Resolve the wallet token, or throw an error that names the two sources tried. */
export async function loadFiatSecret(opts: LoadOptions = {}): Promise<FiatSecretSource> {
  const env = opts.env ?? ((n: string) => Deno.env.get(n));
  const fromEnv = env(ENV_NAME);
  if (fromEnv && fromEnv.trim()) {
    return { source: "env", token: normaliseWalletToken(fromEnv) };
  }

  const fromBao = await openBaoToken(opts);
  if (fromBao) return { source: "openbao", token: fromBao };

  throw new Error(
    `no 2fiat wallet token: set ${ENV_NAME} (materialised from OpenBao by the unit) ` +
      `or make OpenBao reachable with this node's AppRole (${BAO_PATH})`,
  );
}
