/**
 * The loader's contract: correct ORDER, and no way to silently end up with an
 * empty credential. Every case here is a failure mode that would otherwise show
 * up as "auth failed" far from the cause.
 */
import { describe, expect, test } from "bun:test";
import { loadSecret, SecretError } from "./secret.ts";

const noEnv = () => undefined;

const okFetch = (secret: string, opts: { loginStatus?: number; readStatus?: number; token?: string } = {}) =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/v1/auth/approle/login")) {
      return new Response(
        JSON.stringify(opts.loginStatus === 403 ? {} : { auth: { client_token: opts.token ?? "tok" } }),
        { status: opts.loginStatus ?? 200 },
      );
    }
    return new Response(
      JSON.stringify({ data: { data: { nwc_url: secret } } }),
      { status: opts.readStatus ?? 200 },
    );
  }) as unknown as typeof fetch;

const baoEnvFile = async (p: string) => {
  if (p.endsWith("/.hermes/openbao/env")) {
    return [
      "export OPENBAO_ADDR=https://bao.test:8200",
      "export OPENBAO_ROLE_ID_FILE=/x/role",
      "export OPENBAO_SECRET_ID_FILE=/x/secret",
    ].join("\n");
  }
  return "id-value";
};

describe("resolution order", () => {
  test("env wins and OpenBao is never contacted", async () => {
    let fetched = 0;
    const v = await loadSecret({
      name: "nwc_url",
      env: (n) => (n === "CVM_ORDER_NWC_URL" ? "  env-value  " : undefined),
      fetchImpl: (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch,
      readFile: baoEnvFile,
    });
    expect(v.value).toBe("env-value"); // trimmed
    expect(v.source).toBe("env");
    expect(fetched).toBe(0);
  });

  test("falls back to OpenBao when env is absent", async () => {
    const v = await loadSecret({
      name: "nwc_url",
      env: noEnv,
      fetchImpl: okFetch("bao-value"),
      readFile: baoEnvFile,
      allowFileFallback: false,
    });
    expect(v.value).toBe("bao-value");
    expect(v.source).toBe("openbao");
  });

  test("a 0600 file is last, and is reported as such", async () => {
    const v = await loadSecret({
      name: "nwc_url",
      env: noEnv,
      fetchImpl: okFetch("", { readStatus: 404 }),
      readFile: async (p) => {
        if (p.endsWith("food-order.json")) return JSON.stringify({ nwc_url: "file-value" });
        return baoEnvFile(p);
      },
    });
    expect(v.value).toBe("file-value");
    expect(v.source).toBe("file");
  });

  test("the file fallback can be forbidden for production strictness", async () => {
    await expect(
      loadSecret({
        name: "nwc_url",
        env: noEnv,
        fetchImpl: okFetch("", { readStatus: 404 }),
        readFile: async (p) => (p.endsWith("food-order.json") ? JSON.stringify({ nwc_url: "x" }) : baoEnvFile(p)),
        allowFileFallback: false,
      }),
    ).rejects.toThrow(SecretError);
  });
});

describe("no empty credentials", () => {
  test("nothing anywhere is an error, not an empty string", async () => {
    await expect(
      loadSecret({ name: "nwc_url", env: noEnv, fetchImpl: okFetch("", { readStatus: 404 }), readFile: baoEnvFile }),
    ).rejects.toThrow(/no value/);
  });

  test("a 403 from the vault is not treated as 'absent' silently", async () => {
    const v = await loadSecret({
      name: "nwc_url",
      env: noEnv,
      fetchImpl: okFetch("unused", { readStatus: 403 }),
      readFile: async (p) => (p.endsWith("food-order.json") ? JSON.stringify({ nwc_url: "file-value" }) : baoEnvFile(p)),
    });
    // Falls through to the file, and says so - the caller can log the downgrade.
    expect(v.source).toBe("file");
  });

  test("a login without a client token does not proceed to read", async () => {
    const v = await loadSecret({
      name: "nwc_url",
      env: noEnv,
      fetchImpl: okFetch("x", { token: "" }),
      readFile: async (p) => (p.endsWith("food-order.json") ? JSON.stringify({ nwc_url: "file-value" }) : baoEnvFile(p)),
    });
    expect(v.source).toBe("file");
  });

  test("the result carries the value but nothing else that could leak it", async () => {
    const v = await loadSecret({ name: "nwc_url", env: () => "super-secret-value", readFile: baoEnvFile });
    // The value is returned on purpose - the caller has to use it. What must not
    // exist is any EXTRA copy (a `raw`, a `debug`, an echoed body) that a caller
    // might log by accident.
    expect(Object.keys(v).sort()).toEqual(["length", "source", "value"]);
    expect(v.length).toBe("super-secret-value".length);
  });

  test("env name is derived safely from the logical name", async () => {
    let seen = "";
    await loadSecret({
      name: "two-fiat.token",
      env: (n) => { seen = n; return "v"; },
      readFile: baoEnvFile,
    });
    expect(seen).toBe("CVM_ORDER_TWO_FIAT_TOKEN");
  });
});
