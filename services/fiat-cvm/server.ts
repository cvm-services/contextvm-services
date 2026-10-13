/**
 * 2fiat CVM server (ADR-0016) — the fiat leg of the facilitator flow.
 *
 * Speaks the same ContextVM wire protocol as services/restaurant-cvm:
 *   - requests arrive as NIP-44 gift-wrapped kind-1059 events addressed to us
 *   - the inner event is kind 25910 carrying an MCP JSON-RPC message
 *   - replies go back the same way, addressed to the client pubkey
 *
 * The tool set is the fiat one (cards / quote / pay / status). Money-moving calls
 * are gated: only callers in the configured facilitator allowlist may invoke
 * `pay`. Everything else can read.
 *
 * The wallet token comes from the OpenBao-materialised environment (ADR-020) or
 * a direct AppRole read — never from argv, never logged.
 */

import { getPublicKey, generateSecretKey, finalizeEvent } from "npm:nostr-tools/pure";
import { nip44 } from "npm:nostr-tools";
import { Relay } from "npm:nostr-tools/relay";
import { FiatClient } from "./fiat_client.ts";
import { loadFiatSecret } from "./secret.ts";
import { callFiatTool, FIAT_TOOLS } from "./tools.ts";

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface HandlerDeps {
  client: FiatClient;
  /** npub/hex pubkeys allowed to move money. Empty = read-only service. */
  payAllowlist?: string[];
  log?: (msg: string) => void;
}

/** MCP JSON-RPC handler — relay-agnostic so it can be tested without a relay. */
export async function handleMcpMessage(
  deps: HandlerDeps,
  message: McpRequest,
  callerPubkey?: string,
): Promise<McpResponse | null> {
  const { method, id } = message;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "contextvm-2fiat-server", version: "0.1.0" },
      },
    };
  }

  if (method === "notifications/initialized") return null;

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: FIAT_TOOLS } };
  }

  if (method === "tools/call") {
    const toolName = String(message.params?.name ?? "");
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;

    // Money gates: only an allowlisted caller may invoke `pay`.
    if (toolName === "pay") {
      const allow = deps.payAllowlist ?? [];
      if (allow.length === 0) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{
              type: "text",
              text: "pay is disabled: this service has no facilitator allowlist configured",
            }],
          },
        };
      }
      if (!callerPubkey || !allow.includes(callerPubkey)) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{
              type: "text",
              text: "pay refused: caller is not in the facilitator allowlist",
            }],
          },
        };
      }
    }

    try {
      const out = await callFiatTool(deps.client, toolName, args);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(out) }] },
      };
    } catch (e) {
      // Fail loud and visible — silence is the failure mode this guards against.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `tool '${toolName}' failed: ${(e as Error).message}` }],
        },
      };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

export const RELAY_OPTIONS = { enableReconnect: true, enablePing: true } as const;

export interface ServeOptions {
  serverHex: string;
  relays?: string[];
  payAllowlist?: string[];
  log?: (msg: string) => void;
}

/** Connect the relays, subscribe to our gift-wraps, answer MCP calls. */
export async function serve(options: ServeOptions): Promise<() => void> {
  const log = options.log ?? console.log;
  const secret = await loadFiatSecret();
  log(`[fiat-cvm] wallet token loaded from ${secret.source} (len ${secret.token.length})`);
  const client = new FiatClient({ token: secret.token });

  const match = options.serverHex.match(/.{2}/g);
  if (!match) throw new Error("SERVER_HEX is not valid hex");
  const serverSk = new Uint8Array(match.map((b) => parseInt(b, 16)));
  const serverPk = getPublicKey(serverSk);
  const relays = options.relays ?? ["wss://relay2.orangesync.tech", "wss://relay.primal.net"];
  log(`[fiat-cvm] starting; pubkey ${serverPk}`);
  log(`[fiat-cvm] tools: ${FIAT_TOOLS.map((t) => t.name).join(", ")}`);

  const deps: HandlerDeps = { client, payAllowlist: options.payAllowlist, log };
  const connected: Relay[] = [];

  async function sendResponse(message: McpResponse, clientPubkey: string) {
    const inner = finalizeEvent({
      kind: 25910,
      tags: [["p", clientPubkey]],
      content: JSON.stringify(message),
      created_at: Math.floor(Date.now() / 1000),
    }, serverSk);
    const wrapSk = generateSecretKey();
    const convKey = nip44.v2.utils.getConversationKey(wrapSk, clientPubkey);
    const wrapped = finalizeEvent({
      kind: 1059,
      content: nip44.v2.encrypt(JSON.stringify(inner), convKey),
      tags: [["p", clientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    }, wrapSk);
    await Promise.all(connected.map((r) => r.publish(wrapped).catch((e) => {
      log(`[fiat-cvm] publish warning: ${(e as Error).message}`);
      return "";
    })));
  }

  for (const url of relays) {
    try {
      const relay = await Promise.race([
        Relay.connect(url, { ...RELAY_OPTIONS }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("connection timeout (10s)")), 10000)),
      ]);
      connected.push(relay);
      log(`[fiat-cvm] connected to ${url} (reconnect + ping on)`);
      await relay.subscribe(
        [{ kinds: [1059, 21059], "#p": [serverPk], limit: 0 }],
        {
          onevent: async (event) => {
            try {
              const wrapSk = nip44.v2.utils.getConversationKey(
                Uint8Array.from(serverSk),
                event.pubkey,
              );
              const plain = nip44.v2.decrypt(event.content, wrapSk);
              const inner = JSON.parse(plain) as { kind?: number; content?: string; pubkey?: string };
              if (inner.kind !== 25910 || !inner.content) return;
              const req = JSON.parse(inner.content) as McpRequest;
              const res = await handleMcpMessage(deps, req, inner.pubkey);
              if (res) await sendResponse(res, inner.pubkey ?? event.pubkey);
            } catch (e) {
              log(`[fiat-cvm] request failed: ${(e as Error).message}`);
            }
          },
        },
      );
    } catch (e) {
      log(`[fiat-cvm] relay ${url} unavailable: ${(e as Error).message}`);
    }
  }

  log(`[fiat-cvm] live; ${connected.length}/${relays.length} relays connected`);
  return () => {
    for (const r of connected) {
      try {
        r.close();
      } catch { /* already gone */ }
    }
  };
}
