import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Envelope, AuthRequest, ClientType, CliInstance } from "./types.js";

// --- Config ---

export interface RelayConfig {
  apiKey: string;
  authTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatMaxAgeMs: number;
  resumeWindowMs: number;
  backfillSize: number;
  rateLimitMessages: number;
  rateLimitWindowMs: number;
  maxMessageBytes: number;
  maxConnectionsPerIpPerMin: number;
  maxConcurrentConnections: number;
}

const DEFAULT_CONFIG: Omit<RelayConfig, "apiKey"> = {
  authTimeoutMs: 15_000,
  heartbeatIntervalMs: 60_000,
  heartbeatMaxAgeMs: 180_000,
  resumeWindowMs: 3_600_000,
  backfillSize: 50,
  rateLimitMessages: 100,
  rateLimitWindowMs: 10_000,
  maxMessageBytes: 512 * 1024,
  maxConnectionsPerIpPerMin: 10,
  maxConcurrentConnections: 200,
};

// --- Per-connection state ---

interface ClientState {
  authenticated: boolean;
  session_token: string | null;
  client_type: ClientType | null;
  authTimer: ReturnType<typeof setTimeout> | null;
  msgTimestamps: number[];
  rateLimitViolations: number;
}

// --- Relay instance returned from attach ---

export interface RelayServer {
  wss: WebSocketServer;
  close(): void;
  /** Exposed for testing: run one heartbeat sweep now */
  sweepHeartbeats(): void;
}

// --- Helpers ---

function envelope(type: string, payload: Record<string, unknown>): string {
  const msg: Envelope = {
    v: 1,
    type,
    ts: Date.now(),
    id: randomUUID(),
    payload,
  };
  return JSON.stringify(msg);
}

function sendError(ws: WebSocket, message: string): void {
  ws.send(envelope("error", { message }));
}

function parseMessage(raw: string): Envelope | null {
  try {
    const msg = JSON.parse(raw);
    if (msg.v !== 1 || !msg.type) return null;
    return msg as Envelope;
  } catch {
    return null;
  }
}

// Types relayed from CLI → PWA
const CLI_RELAY_TYPES = new Set([
  "agent_output",
  "approval_request",
  "agent_status",
  "encrypted_message",
  "key_exchange_offer",
]);

// Types relayed from PWA → CLI
const PWA_RELAY_TYPES = new Set([
  "user_input",
  "approval_response",
  "encrypted_message",
  "key_exchange_accept",
]);

// --- Bootstrap ---

export function attachWebSocketServer(
  httpServer: HttpServer,
  configOverrides: Partial<RelayConfig> & { apiKey: string },
): RelayServer {
  if (!configOverrides.apiKey || typeof configOverrides.apiKey !== "string") {
    throw new Error("RelayConfig.apiKey is required and must be a non-empty string");
  }
  const config: RelayConfig = { ...DEFAULT_CONFIG, ...configOverrides };

  // Scoped state — each call gets its own isolated state
  const clientStates = new WeakMap<WebSocket, ClientState>();
  const cliInstances = new Map<string, { ws: WebSocket | null; info: CliInstance }>();
  const authenticatedClients = new Set<WebSocket>();
  const lastHeartbeat = new Map<string, number>();
  const outputBuffers = new Map<string, Envelope[]>();

  function getState(ws: WebSocket): ClientState {
    let s = clientStates.get(ws);
    if (!s) {
      s = {
        authenticated: false,
        session_token: null,
        client_type: null,
        authTimer: null,
        msgTimestamps: [],
        rateLimitViolations: 0,
      };
      clientStates.set(ws, s);
    }
    return s;
  }

  function broadcastToPwa(msg: Envelope): void {
    const serialized = JSON.stringify(msg);
    for (const client of authenticatedClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = getState(client);
      if (state.client_type === "pwa") {
        client.send(serialized);
      }
    }
  }

  function routeToCli(instanceId: string, msg: Envelope): boolean {
    const entry = cliInstances.get(instanceId);
    if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) return false;
    entry.ws.send(JSON.stringify(msg));
    return true;
  }

  function buildInstanceList() {
    return Array.from(cliInstances.values()).map((e) => ({
      instance_id: e.info.instance_id,
      name: e.info.name,
      agent_type: e.info.agent_type,
      offline: e.ws === null,
    }));
  }

  // Index: name → instance_id for resume lookups
  const instanceByName = new Map<string, string>();

  function removeInstance(id: string, reason: string): void {
    const entry = cliInstances.get(id);
    if (!entry) return;
    cliInstances.delete(id);
    lastHeartbeat.delete(id);
    outputBuffers.delete(id);
    // Only clear the name→id binding if it still points to this id
    // (hijack-rejection may have left the name pointing at the original owner)
    if (instanceByName.get(entry.info.name) === id) {
      instanceByName.delete(entry.info.name);
    }
    broadcastToPwa({
      v: 1,
      type: reason,
      ts: Date.now(),
      id: randomUUID(),
      payload: {
        instance_id: id,
        name: entry.info.name,
        agent_type: entry.info.agent_type,
      },
    });
  }

  function markInstanceOffline(id: string): void {
    const entry = cliInstances.get(id);
    if (!entry || entry.ws === null) return;
    // Detach the WS but keep the instance + buffer for resume
    entry.ws = null;
    broadcastToPwa({
      v: 1,
      type: "instance_offline",
      ts: Date.now(),
      id: randomUUID(),
      payload: {
        instance_id: id,
        name: entry.info.name,
        agent_type: entry.info.agent_type,
      },
    });
  }

  function bufferOutput(instanceId: string, msg: Envelope): void {
    let buf = outputBuffers.get(instanceId);
    if (!buf) {
      buf = [];
      outputBuffers.set(instanceId, buf);
    }
    buf.push(msg);
    if (buf.length > config.backfillSize) {
      buf.splice(0, buf.length - config.backfillSize);
    }
  }

  // --- Message handlers ---

  function handleAuth(ws: WebSocket, payload: AuthRequest): void {
    const state = getState(ws);

    // H5: reject duplicate auth_request
    if (state.authenticated) {
      sendError(ws, "already authenticated");
      return;
    }

    if (!payload.api_key || !payload.client_type) {
      sendError(ws, "api_key and client_type are required");
      return;
    }

    if (payload.client_type !== "cli" && payload.client_type !== "pwa") {
      sendError(ws, "client_type must be 'cli' or 'pwa'");
      return;
    }

    // C1: real api_key check — any mismatch closes the socket with 4003.
    // Pre-auth rate limiting is enforced by the existing per-connection message
    // rate limit + per-IP connection cap (auth_request is counted like any other).
    if (payload.api_key !== config.apiKey) {
      ws.send(envelope("auth_response", { success: false, error: "invalid api_key" }));
      ws.close(4003, "invalid api_key");
      return;
    }

    // Clear auth timeout
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }

    const session_token = randomUUID();
    state.authenticated = true;
    state.session_token = session_token;
    state.client_type = payload.client_type;
    authenticatedClients.add(ws);

    ws.send(envelope("auth_response", { success: true, session_token }));

    if (payload.client_type === "pwa") {
      ws.send(envelope("instance_list", { instances: buildInstanceList() }));
    }
  }

  function handleInstanceRegister(ws: WebSocket, payload: Record<string, unknown>): void {
    const state = getState(ws);

    if (state.client_type !== "cli") {
      sendError(ws, "only cli clients can register instances");
      return;
    }

    const name = payload.name as string;
    const agent_type = payload.agent_type as string;
    const previous_session_token = payload.previous_session_token as string | undefined;
    if (!name || !agent_type) {
      sendError(ws, "name and agent_type are required");
      return;
    }

    // H2: resume only if caller proves ownership of the previous session
    const existingId = instanceByName.get(name);
    const existingEntry = existingId !== undefined ? cliInstances.get(existingId) : undefined;
    const canResume =
      existingEntry !== undefined &&
      previous_session_token !== undefined &&
      previous_session_token === existingEntry.info.session_token;

    let instance_id: string;
    let resumed: boolean;
    if (canResume && existingId !== undefined) {
      instance_id = existingId;
      resumed = true;
    } else {
      // If name is taken but ownership proof failed, mint a new id under a fresh unique name.
      if (existingEntry !== undefined) {
        // Hijack attempt or brand-new owner reusing a name: do not touch the existing record.
        instance_id = randomUUID();
        resumed = false;
      } else {
        instance_id = randomUUID();
        resumed = false;
      }
    }

    const info: CliInstance = {
      instance_id,
      name,
      agent_type,
      session_token: resumed && existingEntry ? existingEntry.info.session_token : state.session_token!,
    };
    // Only bind name→id when it's a fresh claim or a legitimate resume.
    if (resumed || existingEntry === undefined) {
      cliInstances.set(instance_id, { ws, info });
      instanceByName.set(name, instance_id);
    } else {
      // Ownership proof failed: register the new instance under a separate key
      // so the original owner keeps its resume window.
      cliInstances.set(instance_id, { ws, info });
    }
    lastHeartbeat.set(instance_id, Date.now());

    ws.send(envelope("instance_registered", { instance_id, resumed }));

    broadcastToPwa({
      v: 1,
      type: "instance_registered",
      ts: Date.now(),
      id: randomUUID(),
      payload: { instance_id, name, agent_type, resumed },
    });
  }

  function handleHeartbeat(ws: WebSocket, payload: Record<string, unknown>): void {
    const instanceId = payload.instance_id as string | undefined;
    if (!instanceId) {
      sendError(ws, "instance_id required for heartbeat");
      return;
    }
    const entry = cliInstances.get(instanceId);
    if (!entry || entry.ws !== ws) {
      sendError(ws, `instance ${instanceId} not owned by this connection`);
      return;
    }
    lastHeartbeat.set(instanceId, Date.now());
    ws.send(envelope("heartbeat_ack", { instance_id: instanceId }));
  }

  function handleBackfill(ws: WebSocket, payload: Record<string, unknown>): void {
    const instanceId = payload.instance_id as string | undefined;
    if (!instanceId) {
      sendError(ws, "instance_id required for backfill");
      return;
    }
    const entries = outputBuffers.get(instanceId) || [];
    ws.send(envelope("output_backfill", { instance_id: instanceId, entries }));
  }

  function handleRelay(ws: WebSocket, msg: Envelope): void {
    const state = getState(ws);

    if (state.client_type === "cli" && CLI_RELAY_TYPES.has(msg.type)) {
      if (msg.type === "agent_output") {
        const instanceId = msg.payload.instance_id as string | undefined;
        if (instanceId) bufferOutput(instanceId, msg);
      }
      broadcastToPwa(msg);
      return;
    }

    if (state.client_type === "pwa" && PWA_RELAY_TYPES.has(msg.type)) {
      const instanceId = msg.payload.instance_id as string | undefined;
      if (!instanceId) {
        sendError(ws, "instance_id required for routing to cli");
        return;
      }
      if (!routeToCli(instanceId, msg)) {
        sendError(ws, `cli instance ${instanceId} not found or disconnected`);
      }
      return;
    }

    sendError(ws, `unknown or unauthorized message type: ${msg.type}`);
  }

  function handleDisconnect(ws: WebSocket): void {
    const state = clientStates.get(ws);
    if (state?.authTimer) clearTimeout(state.authTimer);
    authenticatedClients.delete(ws);

    for (const [id, entry] of cliInstances) {
      if (entry.ws === ws) {
        markInstanceOffline(id);
      }
    }
  }

  // --- Heartbeat sweep ---

  function sweepHeartbeats(): void {
    const now = Date.now();
    for (const [id, ts] of lastHeartbeat) {
      const entry = cliInstances.get(id);
      if (!entry) {
        lastHeartbeat.delete(id);
        continue;
      }
      const age = now - ts;
      if (entry.ws !== null && age > config.heartbeatMaxAgeMs) {
        // First pass: online but stale → mark offline, keep buffer for resume
        markInstanceOffline(id);
      } else if (entry.ws === null && age > config.resumeWindowMs) {
        // Second pass: offline past resume window → hard delete
        removeInstance(id, "instance_offline");
      }
    }
  }

  const sweepInterval = setInterval(sweepHeartbeats, config.heartbeatIntervalMs);

  // --- Protection: IP connection rate limiting ---

  const ipConnectionLog = new Map<string, number[]>();

  function checkIpRateLimit(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    let timestamps = ipConnectionLog.get(ip);
    if (!timestamps) {
      timestamps = [];
      ipConnectionLog.set(ip, timestamps);
    }
    // Prune old entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= config.maxConnectionsPerIpPerMin) {
      // H4: drop the entry if it only holds a now-empty array
      if (timestamps.length === 0) ipConnectionLog.delete(ip);
      return false;
    }
    timestamps.push(now);
    return true;
  }

  // H4: periodic GC of ipConnectionLog (entries emptied by the sliding window)
  const ipGcInterval = setInterval(() => {
    const now = Date.now();
    const cutoff = now - 60_000;
    for (const [ip, timestamps] of ipConnectionLog) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) ipConnectionLog.delete(ip);
    }
  }, 60_000);

  // --- Protection: per-connection message rate limiting ---

  function checkMessageRateLimit(state: ClientState): boolean {
    const now = Date.now();
    const cutoff = now - config.rateLimitWindowMs;
    const ts = state.msgTimestamps;
    // Prune old entries
    while (ts.length > 0 && ts[0] <= cutoff) {
      ts.shift();
    }
    if (ts.length >= config.rateLimitMessages) {
      return false;
    }
    ts.push(now);
    return true;
  }

  // --- WebSocket server ---

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }

    // AC-4: max concurrent connections
    if (wss.clients.size >= config.maxConcurrentConnections) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    // AC-2: IP connection rate limit
    const ip = req.socket.remoteAddress || "unknown";
    if (!checkIpRateLimit(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    // Auth timeout: close if not authenticated within deadline
    const state = getState(ws);
    state.authTimer = setTimeout(() => {
      if (!state.authenticated) {
        ws.close(4001, "auth timeout");
      }
    }, config.authTimeoutMs);

    ws.on("message", (raw) => {
      const rawStr = String(raw);

      // AC-3: message size limit
      if (Buffer.byteLength(rawStr, "utf8") > config.maxMessageBytes) {
        ws.send(envelope("message_too_large", {
          message: `message exceeds ${config.maxMessageBytes} byte limit`,
        }));
        return;
      }

      // AC-1: per-connection rate limit
      if (!checkMessageRateLimit(state)) {
        state.rateLimitViolations++;
        ws.send(envelope("rate_limited", {
          message: `rate limit exceeded: max ${config.rateLimitMessages} messages per ${config.rateLimitWindowMs}ms`,
        }));
        if (state.rateLimitViolations >= 3) {
          ws.close(4008, "rate limit exceeded");
        }
        return;
      }

      const msg = parseMessage(rawStr);
      if (!msg) {
        sendError(ws, "invalid envelope: must be JSON with { v: 1, type }");
        return;
      }

      if (msg.type === "auth_request") {
        handleAuth(ws, msg.payload as unknown as AuthRequest);
        return;
      }

      const s = getState(ws);
      if (!s.authenticated) {
        sendError(ws, "not authenticated — send auth_request first");
        return;
      }

      switch (msg.type) {
        case "instance_register":
          handleInstanceRegister(ws, msg.payload);
          break;
        case "instance_list":
          ws.send(envelope("instance_list", { instances: buildInstanceList() }));
          break;
        case "instance_heartbeat":
          handleHeartbeat(ws, msg.payload);
          break;
        case "request_backfill":
          handleBackfill(ws, msg.payload);
          break;
        default:
          handleRelay(ws, msg);
          break;
      }
    });

    ws.on("close", () => handleDisconnect(ws));
  });

  return {
    wss,
    close() {
      clearInterval(sweepInterval);
      clearInterval(ipGcInterval);
      for (const client of wss.clients) {
        client.close(1001, "server shutting down");
      }
      wss.close();
    },
    sweepHeartbeats,
  };
}
