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
    for (const line of text.split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === "OPENBAO_ADDR" && !addr) addr = m[2];
      if (m[1] === "OPENBAO_ROLE_ID_FILE") roleId ||= (await read(m[2]));
      if (m[1] === "OPENBAO_SECRET_ID_FILE") secretId ||= (await read(m[2]));
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
    return body?.data?.data?.token ?? null;
  } catch {
    return null;
  }
}

/** Resolve the wallet token, or throw an error that names the two sources tried. */
export async function loadFiatSecret(opts: LoadOptions = {}): Promise<FiatSecretSource> {
  const env = opts.env ?? ((n: string) => Deno.env.get(n));
  const fromEnv = env(ENV_NAME);
  if (fromEnv && fromEnv.trim()) return { source: "env", token: fromEnv.trim() };

  const fromBao = await openBaoToken(opts);
  if (fromBao) return { source: "openbao", token: fromBao };

  throw new Error(
    `no 2fiat wallet token: set ${ENV_NAME} (materialised from OpenBao by the unit) ` +
      `or make OpenBao reachable with this node's AppRole (${BAO_PATH})`,
  );
}
