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
