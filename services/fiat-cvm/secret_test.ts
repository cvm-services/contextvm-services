import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadFiatSecret } from "./secret.ts";

const TOKEN = "token1testonlynotarealtoken";

function fakeBao(token: string | null, opts: { loginFails?: boolean; readFails?: boolean } = {}) {
  const calls: string[] = [];
  const fn = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/auth/approle/login")) {
      if (opts.loginFails) return Promise.resolve(new Response("{}", { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify({ auth: { client_token: "s.testtoken" } }), { status: 200 }));
    }
    if (url.includes("/v1/secret/data/fleet/2fiat")) {
      if (opts.readFails) return Promise.resolve(new Response("{}", { status: 403 }));
      return Promise.resolve(new Response(JSON.stringify({ data: { data: { token } } }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

Deno.test("the real ~/.hermes/openbao/env shape parses (it uses `export NAME=value`)", async () => {
  // Regression: a parser that required the line to START with the name parsed
  // the fleet's file to nothing, so a perfectly reachable vault reported
  // "no token". The file is valid shell with an `export ` prefix.
  const dir = await Deno.makeTempDir();
  const roleFile = `${dir}/role-id`;
  const secretFile = `${dir}/secret-id`;
  await Deno.writeTextFile(roleFile, "role-abc\n");
  await Deno.writeTextFile(secretFile, "secret-xyz\n");
  const envFile = `${dir}/env`;
  await Deno.writeTextFile(
    envFile,
    `export OPENBAO_ADDR=http://bao.test:8200\nexport OPENBAO_ROLE_ID_FILE=${roleFile}\nexport OPENBAO_SECRET_ID_FILE=${secretFile}\n`,
  );

  const { fn } = fakeBao(TOKEN);
  const s = await loadFiatSecret({
    env: () => undefined,
    baoEnvFile: envFile,
    fetchImpl: fn,
  });
  assertEquals(s.source, "openbao");
  assertEquals(s.token, TOKEN);
});

Deno.test("the environment wins — that is the systemd EnvironmentFile path", async () => {
  const s = await loadFiatSecret({
    env: (n) => (n === "TWO_FIAT_TOKEN" ? TOKEN : undefined),
    fetchImpl: (() => Promise.reject(new Error("must not touch the network"))) as unknown as typeof fetch,
  });
  assertEquals(s.source, "env");
  assertEquals(s.token, TOKEN);
});

Deno.test("falls back to OpenBao over the AppRole when the env is empty", async () => {
  const { fn, calls } = fakeBao(TOKEN);
  const s = await loadFiatSecret({
    env: () => undefined,
    baoAddr: "http://bao.test:8200",
    roleId: "role-abc",
    secretId: "secret-xyz",
    fetchImpl: fn,
  });
  assertEquals(s.source, "openbao");
  assertEquals(s.token, TOKEN);
  if (!calls.some((c) => c.includes("/v1/auth/approle/login"))) {
    throw new Error("AppRole login was not attempted");
  }
});

Deno.test("a denied vault read does not silently yield an empty token", async () => {
  const { fn } = fakeBao(TOKEN, { readFails: true });
  await assertRejects(() =>
    loadFiatSecret({
      env: () => undefined,
      baoAddr: "http://bao.test:8200",
      roleId: "r",
      secretId: "s",
      fetchImpl: fn,
    })
  );
});

Deno.test("a failed AppRole login does not silently yield an empty token", async () => {
  const { fn } = fakeBao(TOKEN, { loginFails: true });
  await assertRejects(() =>
    loadFiatSecret({
      env: () => undefined,
      baoAddr: "http://bao.test:8200",
      roleId: "r",
      secretId: "s",
      fetchImpl: fn,
    })
  );
});

Deno.test("no reachable source reports BOTH the env name and the vault path", async () => {
  await assertRejects(
    () => loadFiatSecret({ env: () => undefined, baoAddr: "", roleId: "", secretId: "", baoEnvFile: "/nonexistent" }),
    Error,
    "TWO_FIAT_TOKEN",
  );
});

Deno.test("the token is never logged: the loader's error text carries no secret", async () => {
  const { fn } = fakeBao(TOKEN, { readFails: true });
  try {
    await loadFiatSecret({ env: () => undefined, baoAddr: "http://x:8200", roleId: "r", secretId: "s", fetchImpl: fn });
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes(TOKEN)) throw new Error("the wallet token leaked into an error message");
  }
});


// ---- RED: the vault stores a WALLET URL, not a bare token -------------------
//
// Measured 2026-10-19: the `2fiat` field in OpenBao holds
//   https://2fiat.com/wallet/token1anz2skuq8pzf8x0w7302axmu4gjfdjmc/my-cards
// (72 chars). The CREDENTIAL is the `token1...` path segment (38 chars -- which is
// exactly the length the running service logged). Returning the raw field makes
// every consumer send `Bearer https://...` and 2fiat answers 401 Unauthorized.
//
// These tests pin the normalisation so a wallet URL can never again be mistaken
// for a token.
const WALLET_URL =
  "https://2fiat.com/wallet/token1anz2skuq8pzf8x0w7302axmu4gjfdjmc/my-cards";
const BARE_TOKEN = "token1anz2skuq8pzf8x0w7302axmu4gjfdjmc";

Deno.test("a wallet URL from the vault is normalised to the bare token", async () => {
  const { fn } = fakeBao(WALLET_URL);
  const s = await loadFiatSecret({
    env: () => undefined, baoAddr: "http://x:8200", roleId: "r", secretId: "s",
    fetchImpl: fn,
  });
  assertEquals(s.token, BARE_TOKEN);
  assertEquals(s.token.length, 38);
});

Deno.test("a bare token is passed through unchanged", async () => {
  const { fn } = fakeBao(BARE_TOKEN);
  const s = await loadFiatSecret({
    env: () => undefined, baoAddr: "http://x:8200", roleId: "r", secretId: "s",
    fetchImpl: fn,
  });
  assertEquals(s.token, BARE_TOKEN);
});

Deno.test("normalisation never leaks the URL into the token", async () => {
  const { fn } = fakeBao(WALLET_URL);
  const s = await loadFiatSecret({
    env: () => undefined, baoAddr: "http://x:8200", roleId: "r", secretId: "s",
    fetchImpl: fn,
  });
  if (s.token.includes("://") || s.token.includes("/")) {
    throw new Error(`token still looks like a URL: ${s.token.slice(0, 12)}...`);
  }
});

Deno.test("an env token that is a wallet URL is normalised too", async () => {
  const s = await loadFiatSecret({ env: () => WALLET_URL, baoEnvFile: "/nonexistent" });
  assertEquals(s.token, BARE_TOKEN);
});
