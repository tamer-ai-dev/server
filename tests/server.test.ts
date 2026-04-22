import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server as HttpServer } from "node:http";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { attachWebSocketServer, type RelayServer } from "../src/server.js";

// --- Test helpers ---

let httpServer: HttpServer;
let relay: RelayServer;
let port: number;
const openSockets: WebSocket[] = [];

const TEST_API_KEY = "test-key";

function startServer(config?: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    httpServer = createServer();
    const merged = { apiKey: TEST_API_KEY, ...(config ?? {}) };
    relay = attachWebSocketServer(httpServer, merged as { apiKey: string });
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    openSockets.length = 0;
    relay.close();
    httpServer.close(() => resolve());
  });
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openSockets.push(ws);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Connect and expect the upgrade to be rejected (non-101 response) */
function connectExpectReject(): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openSockets.push(ws);
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on("open", () => reject(new Error("expected rejection but got open")));
  });
}

function send(ws: WebSocket, type: string, payload: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ v: 1, type, ts: Date.now(), id: randomUUID(), payload }));
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (raw: Buffer) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg.payload);
      }
    };
    ws.on("message", handler);
  });
}

function auth(ws: WebSocket, clientType: "cli" | "pwa"): Promise<Record<string, unknown>> {
  const p = waitForMessage(ws, "auth_response");
  send(ws, "auth_request", { api_key: TEST_API_KEY, client_type: clientType });
  return p;
}

/** Auth as PWA and consume the initial instance_list that follows auth_response */
async function authPwa(ws: WebSocket): Promise<{ auth: Record<string, unknown>; list: Record<string, unknown> }> {
  const listP = waitForMessage(ws, "instance_list");
  const authPayload = await auth(ws, "pwa");
  const listPayload = await listP;
  return { auth: authPayload, list: listPayload };
}

async function authAndRegister(ws: WebSocket, name = "test-agent", agentType = "claude"): Promise<string> {
  await auth(ws, "cli");
  const p = waitForMessage(ws, "instance_registered");
  send(ws, "instance_register", { name, agent_type: agentType });
  const payload = await p;
  return payload.instance_id as string;
}

afterEach(async () => {
  await stopServer();
});

// --- Tests ---

describe("auth flow", () => {
  it("authenticates a cli client", async () => {
    await startServer();
    const ws = await connect();
    const payload = await auth(ws, "cli");
    expect(payload.success).toBe(true);
    expect(payload.session_token).toBeDefined();
  });

  it("authenticates a pwa client and receives instance_list", async () => {
    await startServer();
    const ws = await connect();
    const { list } = await authPwa(ws);
    expect(list.instances).toEqual([]);
  });

  it("rejects missing api_key", async () => {
    await startServer();
    const ws = await connect();
    const errP = waitForMessage(ws, "error");
    send(ws, "auth_request", { api_key: "", client_type: "cli" });
    const err = await errP;
    expect(err.message).toContain("api_key");
  });

  it("rejects messages before auth", async () => {
    await startServer();
    const ws = await connect();
    const errP = waitForMessage(ws, "error");
    send(ws, "instance_register", { name: "x", agent_type: "y" });
    const err = await errP;
    expect(err.message).toContain("not authenticated");
  });
});

describe("instance registration", () => {
  it("registers a cli instance and assigns UUID", async () => {
    await startServer();
    const ws = await connect();
    const id = await authAndRegister(ws);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("notifies pwa on registration", async () => {
    await startServer();
    const pwa = await connect();
    await authPwa(pwa);

    const cli = await connect();
    const regP = waitForMessage(pwa, "instance_registered");
    await authAndRegister(cli, "my-agent", "claude");
    const payload = await regP;
    expect(payload.name).toBe("my-agent");
    expect(payload.agent_type).toBe("claude");
  });

  it("rejects registration from pwa", async () => {
    await startServer();
    const ws = await connect();
    await authPwa(ws);
    const errP = waitForMessage(ws, "error");
    send(ws, "instance_register", { name: "x", agent_type: "y" });
    const err = await errP;
    expect(err.message).toContain("only cli");
  });
});

describe("relay CLI → PWA", () => {
  it("relays agent_output from cli to pwa", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const pwa = await connect();
    await authPwa(pwa);

    const relayP = waitForMessage(pwa, "agent_output");
    send(cli, "agent_output", { instance_id: instanceId, text: "hello" });
    const payload = await relayP;
    expect(payload.text).toBe("hello");
  });
});

describe("relay PWA → CLI", () => {
  it("routes user_input from pwa to specific cli instance", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const pwa = await connect();
    await authPwa(pwa);

    const inputP = waitForMessage(cli, "user_input");
    send(pwa, "user_input", { instance_id: instanceId, text: "go" });
    const payload = await inputP;
    expect(payload.text).toBe("go");
  });

  it("errors if instance_id missing", async () => {
    await startServer();
    const pwa = await connect();
    await authPwa(pwa);

    const errP = waitForMessage(pwa, "error");
    send(pwa, "user_input", { text: "go" });
    const err = await errP;
    expect(err.message).toContain("instance_id required");
  });
});

describe("heartbeat", () => {
  it("acknowledges heartbeat", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const ackP = waitForMessage(cli, "heartbeat_ack");
    send(cli, "instance_heartbeat", { instance_id: instanceId });
    const payload = await ackP;
    expect(payload.instance_id).toBe(instanceId);
  });

  it("sweeps stale instances and notifies pwa", async () => {
    await startServer({ heartbeatMaxAgeMs: 1 });
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const pwa = await connect();
    await authPwa(pwa);

    // Wait a tiny bit so heartbeat is stale (maxAge=1ms)
    await new Promise((r) => setTimeout(r, 10));

    const offlineP = waitForMessage(pwa, "instance_offline");
    relay.sweepHeartbeats();
    const payload = await offlineP;
    expect(payload.instance_id).toBe(instanceId);
  });
});

describe("output backfill", () => {
  it("returns buffered agent_output messages", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    // Send some output
    for (let i = 0; i < 3; i++) {
      send(cli, "agent_output", { instance_id: instanceId, text: `msg-${i}` });
    }

    // Small delay for messages to process
    await new Promise((r) => setTimeout(r, 50));

    const pwa = await connect();
    await authPwa(pwa);

    const backfillP = waitForMessage(pwa, "output_backfill");
    send(pwa, "request_backfill", { instance_id: instanceId });
    const payload = await backfillP;
    const entries = payload.entries as Array<{ payload: { text: string } }>;
    expect(entries).toHaveLength(3);
    expect(entries[0].payload.text).toBe("msg-0");
    expect(entries[2].payload.text).toBe("msg-2");
  });

  it("caps buffer at configured size", async () => {
    await startServer({ backfillSize: 5 });
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    for (let i = 0; i < 10; i++) {
      send(cli, "agent_output", { instance_id: instanceId, text: `msg-${i}` });
    }
    await new Promise((r) => setTimeout(r, 50));

    const pwa = await connect();
    await authPwa(pwa);

    const backfillP = waitForMessage(pwa, "output_backfill");
    send(pwa, "request_backfill", { instance_id: instanceId });
    const payload = await backfillP;
    const entries = payload.entries as Array<{ payload: { text: string } }>;
    expect(entries).toHaveLength(5);
    // Should have the last 5 messages
    expect(entries[0].payload.text).toBe("msg-5");
  });
});

describe("auth timeout", () => {
  it("closes connection if no auth within deadline", async () => {
    await startServer({ authTimeoutMs: 100 });
    const ws = await connect();

    const closeP = new Promise<{ code: number }>((resolve) => {
      ws.on("close", (code) => resolve({ code }));
    });

    const result = await closeP;
    expect(result.code).toBe(4001);
  });
});

describe("instance resume", () => {
  it("reuses instance_id when same name reconnects with valid previous_session_token", async () => {
    await startServer();
    const cli1 = await connect();
    const auth1 = await auth(cli1, "cli");
    const sessionToken1 = auth1.session_token as string;
    const reg1P = waitForMessage(cli1, "instance_registered");
    send(cli1, "instance_register", { name: "my-agent", agent_type: "claude" });
    const id1 = (await reg1P).instance_id as string;

    // Disconnect CLI
    const closeP = new Promise<void>((r) => cli1.on("close", () => r()));
    cli1.close();
    await closeP;
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect with same name + previous_session_token
    const cli2 = await connect();
    await auth(cli2, "cli");
    const regP = waitForMessage(cli2, "instance_registered");
    send(cli2, "instance_register", {
      name: "my-agent",
      agent_type: "claude",
      previous_session_token: sessionToken1,
    });
    const payload = await regP;

    expect(payload.instance_id).toBe(id1);
    expect(payload.resumed).toBe(true);
  });

  it("preserves output buffer across reconnect", async () => {
    await startServer();
    const cli1 = await connect();
    const auth1 = await auth(cli1, "cli");
    const sessionToken1 = auth1.session_token as string;
    const reg1P = waitForMessage(cli1, "instance_registered");
    send(cli1, "instance_register", { name: "buf-agent", agent_type: "claude" });
    const instanceId = (await reg1P).instance_id as string;

    // Send output before disconnect
    send(cli1, "agent_output", { instance_id: instanceId, text: "before-disconnect" });
    await new Promise((r) => setTimeout(r, 50));

    // Disconnect
    const closeP = new Promise<void>((r) => cli1.on("close", () => r()));
    cli1.close();
    await closeP;
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect with previous_session_token
    const cli2 = await connect();
    await auth(cli2, "cli");
    const regP = waitForMessage(cli2, "instance_registered");
    send(cli2, "instance_register", {
      name: "buf-agent",
      agent_type: "claude",
      previous_session_token: sessionToken1,
    });
    await regP;

    // PWA requests backfill — should still have pre-disconnect output
    const pwa = await connect();
    await authPwa(pwa);

    const backfillP = waitForMessage(pwa, "output_backfill");
    send(pwa, "request_backfill", { instance_id: instanceId });
    const payload = await backfillP;
    const entries = payload.entries as Array<{ payload: { text: string } }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].payload.text).toBe("before-disconnect");
  });

  it("creates new instance_id for different name", async () => {
    await startServer();
    const cli1 = await connect();
    const id1 = await authAndRegister(cli1, "agent-a", "claude");

    const cli2 = await connect();
    const id2 = await authAndRegister(cli2, "agent-b", "claude");

    expect(id1).not.toBe(id2);
  });
});

describe("H2: resume ownership check", () => {
  it("mints a new instance_id when previous_session_token is missing", async () => {
    await startServer();
    const cli1 = await connect();
    const id1 = await authAndRegister(cli1, "owned-agent", "claude");

    const cli2 = await connect();
    await auth(cli2, "cli");
    const regP = waitForMessage(cli2, "instance_registered");
    // No previous_session_token — hijack attempt
    send(cli2, "instance_register", { name: "owned-agent", agent_type: "claude" });
    const payload = await regP;

    expect(payload.resumed).toBe(false);
    expect(payload.instance_id).not.toBe(id1);
  });

  it("mints a new instance_id when previous_session_token is wrong", async () => {
    await startServer();
    const cli1 = await connect();
    const id1 = await authAndRegister(cli1, "owned-agent-2", "claude");

    const cli2 = await connect();
    await auth(cli2, "cli");
    const regP = waitForMessage(cli2, "instance_registered");
    send(cli2, "instance_register", {
      name: "owned-agent-2",
      agent_type: "claude",
      previous_session_token: "not-the-real-token",
    });
    const payload = await regP;

    expect(payload.resumed).toBe(false);
    expect(payload.instance_id).not.toBe(id1);
  });
});

describe("disconnect broadcasts instance_offline", () => {
  it("notifies pwa when cli disconnects", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli, "offline-test", "claude");

    const pwa = await connect();
    await authPwa(pwa);

    const offlineP = waitForMessage(pwa, "instance_offline");
    cli.close();
    const payload = await offlineP;
    expect(payload.instance_id).toBe(instanceId);
    expect(payload.name).toBe("offline-test");
  });
});

describe("graceful shutdown", () => {
  it("closes all connections with code 1001", async () => {
    await startServer();
    const cli = await connect();
    await auth(cli, "cli");

    const pwa = await connect();
    await authPwa(pwa);

    const cliCloseP = new Promise<number>((r) => cli.on("close", (code) => r(code)));
    const pwaCloseP = new Promise<number>((r) => pwa.on("close", (code) => r(code)));

    relay.close();

    const [cliCode, pwaCode] = await Promise.all([cliCloseP, pwaCloseP]);
    expect(cliCode).toBe(1001);
    expect(pwaCode).toBe(1001);
  });
});

describe("protection: per-connection rate limit", () => {
  it("sends rate_limited after exceeding message limit", async () => {
    await startServer({ rateLimitMessages: 5, rateLimitWindowMs: 10_000 });
    const ws = await connect();
    await auth(ws, "cli");

    // Send 5 messages (at limit)
    for (let i = 0; i < 5; i++) {
      send(ws, "instance_list", {});
    }
    // 6th should trigger rate_limited
    const errP = waitForMessage(ws, "rate_limited");
    send(ws, "instance_list", {});
    const payload = await errP;
    expect(payload.message).toContain("rate limit");
  });

  it("closes connection after 3 rate limit violations", async () => {
    await startServer({ rateLimitMessages: 2, rateLimitWindowMs: 60_000 });
    const ws = await connect();
    await auth(ws, "cli");

    const closeP = new Promise<number>((r) => ws.on("close", (code) => r(code)));

    // Burn through the limit then trigger 3 violations
    for (let i = 0; i < 10; i++) {
      send(ws, "instance_list", {});
    }

    const code = await closeP;
    expect(code).toBe(4008);
  });
});

describe("protection: message size limit", () => {
  it("rejects oversized messages with message_too_large", async () => {
    await startServer({ maxMessageBytes: 256 });
    const ws = await connect();
    await auth(ws, "cli");

    const errP = waitForMessage(ws, "message_too_large");
    // Send a message larger than 256 bytes
    const bigPayload = "x".repeat(300);
    ws.send(JSON.stringify({ v: 1, type: "agent_output", ts: Date.now(), id: randomUUID(), payload: { data: bigPayload } }));
    const payload = await errP;
    expect(payload.message).toContain("256");
  });
});

describe("protection: max concurrent connections", () => {
  it("rejects with 503 when connection cap is reached", async () => {
    await startServer({ maxConcurrentConnections: 2 });
    await connect();
    await connect();

    // 3rd connection should be rejected
    const result = await connectExpectReject();
    expect(result.status).toBe(503);
  });
});

describe("protection: IP connection rate limit", () => {
  it("rejects with 429 when IP connects too often", async () => {
    await startServer({ maxConnectionsPerIpPerMin: 3 });
    await connect();
    await connect();
    await connect();

    // 4th connection from same IP should be rejected
    const result = await connectExpectReject();
    expect(result.status).toBe(429);
  });
});

describe("E2E encryption relay", () => {
  it("relays key_exchange_offer from CLI to PWA", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const pwa = await connect();
    await authPwa(pwa);

    const offerP = waitForMessage(pwa, "key_exchange_offer");
    send(cli, "key_exchange_offer", { instance_id: instanceId, public_key: "cli-pub-key-abc" });
    const payload = await offerP;
    expect(payload.instance_id).toBe(instanceId);
    expect(payload.public_key).toBe("cli-pub-key-abc");
  });

  it("relays key_exchange_accept from PWA to CLI", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const pwa = await connect();
    await authPwa(pwa);

    const acceptP = waitForMessage(cli, "key_exchange_accept");
    send(pwa, "key_exchange_accept", { instance_id: instanceId, public_key: "pwa-pub-key-xyz" });
    const payload = await acceptP;
    expect(payload.instance_id).toBe(instanceId);
    expect(payload.public_key).toBe("pwa-pub-key-xyz");
  });

  it("relays encrypted_message from CLI to PWA", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const pwa = await connect();
    await authPwa(pwa);

    const msgP = waitForMessage(pwa, "encrypted_message");
    send(cli, "encrypted_message", { instance_id: instanceId, nonce: "nonce123", ciphertext: "encrypted-data" });
    const payload = await msgP;
    expect(payload.instance_id).toBe(instanceId);
    expect(payload.nonce).toBe("nonce123");
    expect(payload.ciphertext).toBe("encrypted-data");
  });

  it("relays encrypted_message from PWA to CLI", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli);

    const pwa = await connect();
    await authPwa(pwa);

    const msgP = waitForMessage(cli, "encrypted_message");
    send(pwa, "encrypted_message", { instance_id: instanceId, nonce: "nonce456", ciphertext: "reply-encrypted" });
    const payload = await msgP;
    expect(payload.instance_id).toBe(instanceId);
    expect(payload.nonce).toBe("nonce456");
    expect(payload.ciphertext).toBe("reply-encrypted");
  });
});

describe("C1: real api_key authentication", () => {
  it("rejects wrong api_key with close code 4003", async () => {
    await startServer();
    const ws = await connect();

    const closeP = new Promise<{ code: number }>((resolve) => {
      ws.on("close", (code) => resolve({ code }));
    });
    const authP = waitForMessage(ws, "auth_response");

    send(ws, "auth_request", { api_key: "wrong-key", client_type: "cli" });

    const authPayload = await authP;
    expect(authPayload.success).toBe(false);

    const result = await closeP;
    expect(result.code).toBe(4003);
  });

  it("refuses to build relay without apiKey config", () => {
    // The attachWebSocketServer helper requires apiKey
    const http = createServer();
    expect(() =>
      attachWebSocketServer(http, { apiKey: "" } as unknown as { apiKey: string }),
    ).toThrow(/apiKey is required/);
    http.close();
  });
});

describe("H1: null-ws safety after markInstanceOffline", () => {
  it("does not crash when PWA routes to an offline instance", async () => {
    await startServer();
    const cli = await connect();
    const instanceId = await authAndRegister(cli, "offline-route", "claude");

    const pwa = await connect();
    await authPwa(pwa);

    // CLI disconnects — instance is marked offline (ws = null)
    const closeP = new Promise<void>((r) => cli.on("close", () => r()));
    cli.close();
    await closeP;
    await new Promise((r) => setTimeout(r, 50));

    // PWA tries to route to the now-offline instance — must get an error, not crash
    const errP = waitForMessage(pwa, "error");
    send(pwa, "user_input", { instance_id: instanceId, text: "hello?" });
    const err = await errP;
    expect(err.message).toContain("not found or disconnected");
  });
});

describe("H5: reject duplicate auth_request", () => {
  it("returns error on second auth_request and keeps client_type", async () => {
    await startServer();
    const ws = await connect();
    const first = await auth(ws, "cli");
    expect(first.success).toBe(true);

    // Second auth_request — should get error, not a new auth_response
    const errP = waitForMessage(ws, "error");
    send(ws, "auth_request", { api_key: TEST_API_KEY, client_type: "pwa" });
    const err = await errP;
    expect(err.message).toContain("already authenticated");

    // Confirm client is still treated as a cli (pwa-only action fails)
    const regP = waitForMessage(ws, "instance_registered");
    send(ws, "instance_register", { name: "still-cli", agent_type: "claude" });
    const payload = await regP;
    expect(payload.instance_id).toBeDefined();
  });
});

describe("H3: heartbeat sweep marks offline then removes after resume window", () => {
  it("first pass marks instance offline, second pass removes after resumeWindowMs", async () => {
    await startServer({ heartbeatMaxAgeMs: 1, resumeWindowMs: 1 });
    const cli = await connect();
    const instanceId = await authAndRegister(cli, "sweep-agent", "claude");

    const pwa = await connect();
    await authPwa(pwa);

    // First sweep: instance is online but heartbeat stale → mark offline
    await new Promise((r) => setTimeout(r, 10));
    const offlineP = waitForMessage(pwa, "instance_offline");
    relay.sweepHeartbeats();
    const offlinePayload = await offlineP;
    expect(offlinePayload.instance_id).toBe(instanceId);

    // Second sweep: already offline and past resume window → hard delete (broadcasts instance_offline again)
    await new Promise((r) => setTimeout(r, 10));
    const removedP = waitForMessage(pwa, "instance_offline");
    relay.sweepHeartbeats();
    const removedPayload = await removedP;
    expect(removedPayload.instance_id).toBe(instanceId);
  });
});
