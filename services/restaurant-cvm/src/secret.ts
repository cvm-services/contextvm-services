/**
 * Secrets for the food-order workstream.
 *
 * Resolution order, and why it is this order:
 *   1. ENV — how a systemd unit receives a value materialised from the vault at
 *      start time. No file on disk, nothing in the process listing.
 *   2. OPENBAO — this node's AppRole over the fleet address, for one-shot runs
 *      where no unit has materialised the env.
 *   3. A 0600 file — the documented stopgap until the vault grant exists. It is
 *      LAST, and it is reported as `file` so a caller can log that it happened.
 *
 * Invariants:
 *   - never from argv (visible in `ps`, in shell history, in logs)
 *   - never logged: only the SOURCE and the LENGTH may be reported
 *   - a missing secret is an error, not an empty string ("" would authenticate
 *     as nothing and fail later, far from the cause)
 */

export type SecretSource = "env" | "openbao" | "file";

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
  /** Safe to log. */
  length: number;
}

export class SecretError extends Error {}

export interface BaoEnv {
  addr: string;
  roleId: string;
  secretId: string;
}

export interface LoadSecretOptions {
  /** Logical name, e.g. "nwc_url". Also the env var suffix: CVM_ORDER_<NAME>. */
  name: string;
  env?: (n: string) => string | undefined;
  fetchImpl?: typeof fetch;
  readFile?: (p: string) => Promise<string>;
  /** Defaults to secret/data/fleet/food-order */
  baoPath?: string;
  /** Defaults to $HOME/.hermes/openbao/env */
  baoEnvFile?: string;
  /** Defaults to $HOME/.hermes/secrets/food-order.json */
  fallbackFile?: string;
  /** Set false to forbid the 0600 fallback entirely (production strictness). */
  allowFileFallback?: boolean;
}

const ENV_PREFIX = "CVM_ORDER_";

export async function loadSecret(opts: LoadSecretOptions): Promise<ResolvedSecret> {
  const env = opts.env ?? ((n: string) => Deno.env.get(n));
  const read = opts.readFile ?? (async (p: string) => await Deno.readTextFile(p));

  // 1. environment
  const envName = ENV_PREFIX + opts.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const fromEnv = env(envName);
  if (fromEnv && fromEnv.trim()) {
    return { value: fromEnv.trim(), source: "env", length: fromEnv.trim().length };
  }

  // 2. OpenBao
  try {
    const bao = await readBaoEnv(opts, env, read);
    if (bao) {
      const v = await readBaoSecret(bao, opts, read, env);
      if (v) return { value: v, source: "openbao", length: v.length };
    }
  } catch {
    // fall through: an unreachable vault must not look like a wrong secret
  }

  // 3. 0600 file (documented stopgap)
  if (opts.allowFileFallback !== false) {
    const home = env("HOME") ?? "";
    const path = opts.fallbackFile ?? `${home}/.hermes/secrets/food-order.json`;
    try {
      const raw = await read(path);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v = parsed?.[opts.name];
      if (typeof v === "string" && v.trim()) {
        return { value: v.trim(), source: "file", length: v.trim().length };
      }
    } catch { /* absent is fine; absence is reported below */ }
  }

  throw new SecretError(
    `no value for "${opts.name}": not in ${envName}, not in OpenBao, and no usable 0600 fallback`,
  );
}

async function readBaoEnv(
  opts: LoadSecretOptions,
  env: (n: string) => string | undefined,
  read: (p: string) => Promise<string>,
): Promise<BaoEnv | null> {
  if (env("OPENBAO_ADDR") && env("OPENBAO_ROLE_ID") && env("OPENBAO_SECRET_ID")) {
    return {
      addr: env("OPENBAO_ADDR")!,
      roleId: env("OPENBAO_ROLE_ID")!,
      secretId: env("OPENBAO_SECRET_ID")!,
    };
  }
  const home = env("HOME") ?? "";
  const text = await read(opts.baoEnvFile ?? `${home}/.hermes/openbao/env`);
  let addr = "";
  let roleFile = "";
  let secretFile = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (m[1] === "OPENBAO_ADDR") addr = value;
    if (m[1] === "OPENBAO_ROLE_ID_FILE") roleFile = value;
    if (m[1] === "OPENBAO_SECRET_ID_FILE") secretFile = value;
  }
  if (!addr || !roleFile || !secretFile) return null;
  return { addr, roleId: (await read(roleFile)).trim(), secretId: (await read(secretFile)).trim() };
}

async function readBaoSecret(
  bao: BaoEnv,
  opts: LoadSecretOptions,
  read: (p: string) => Promise<string>,
  env: (n: string) => string | undefined,
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = bao.addr.replace(/\/+$/, "");

  const login = await fetchImpl(`${base}/v1/auth/approle/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role_id: bao.roleId, secret_id: bao.secretId }),
  });
  if (!login.ok) throw new SecretError(`approle login http ${login.status}`);
  const loginBody = await login.json() as { auth?: { client_token?: string } };
  const token = loginBody?.auth?.client_token;
  // An empty client token must stop here: continuing would read with no auth and
  // report "no secret" for a perfectly good vault.
  if (!token) throw new SecretError("approle login returned no client token");

  const path = (opts.baoPath ?? "secret/data/fleet/food-order").replace(/^\/+/, "");
  const res = await fetchImpl(`${base}/v1/${path}`, { headers: { "x-vault-token": token } });
  if (res.status === 403) throw new SecretError("openbao refused this path (no grant)");
  if (!res.ok) throw new SecretError(`openbao http ${res.status}`);
  const body = await res.json() as { data?: { data?: Record<string, unknown> } };
  const v = body?.data?.data?.[opts.name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
