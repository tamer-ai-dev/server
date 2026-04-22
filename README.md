# @tamer-ai/server

![version](https://img.shields.io/badge/version-0.6.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D22-green)
![license](https://img.shields.io/badge/license-MIT-brightgreen)

## What is this

An open-source WebSocket relay server that bridges CLI agents and a PWA dashboard in real-time. CLI agents connect, register, and stream output through the server; PWA clients receive that output live and can send input back. The server never inspects payload content and supports end-to-end encryption as a transparent passthrough.

```
CLI agent --> WebSocket --> server --> WebSocket --> PWA browser
PWA browser --> WebSocket --> server --> WebSocket --> CLI agent
```

## Features

- **WebSocket relay** (CLI <-> PWA) with typed envelope protocol (v1)
- **Authentication** with API key + session tokens
- **CLI instance registration** with auto-resume on reconnect (same name = same instance_id)
- **Heartbeat monitoring** + stale instance cleanup (configurable sweep interval and max age)
- **Output buffering** + backfill for PWA late-joiners (ring buffer, default 50 messages)
- **Rate limiting** per-message (100 msg / 10s) + per-IP connection cap (10 / min)
- **Message size limit** (512 KB default)
- **Max concurrent connections** cap (200 default)
- **E2E encryption relay** (key_exchange_offer/accept + encrypted_message pass-through)
- **Graceful shutdown** on SIGTERM / SIGINT (closes all connections with code 1001)
- **Health check endpoint** (`GET /health`)

## Quick start

```bash
# Install dependencies
npm install

# Development (hot-reload)
npm run dev

# Production build
npm run build
npm start

# Run tests
npm test
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | HTTP + WebSocket listen port |
| `TAMER_API_KEY` | *(required)* | Shared secret that CLI/PWA clients must send in `auth_request.api_key`. Server refuses to start if unset. |

## Docker

```bash
# Using docker compose
docker compose up

# Or build and run manually
docker build -t tamer-ai-server .
docker run -d -p 3000:3000 --name tamer-ai tamer-ai-server
```

The Dockerfile uses a multi-stage build on `node:22-alpine` -- TypeScript compiles in the builder stage, and only production dependencies are copied to the final image.

## Configuration

All relay behavior is configurable via `RelayConfig`. Defaults are designed for typical usage:

| Field | Default | Description |
|-------|---------|-------------|
| `authTimeoutMs` | `15000` | Close connection if no auth_request within this window |
| `heartbeatIntervalMs` | `60000` | How often the server sweeps for stale instances |
| `heartbeatMaxAgeMs` | `180000` | Max time since last heartbeat before instance is marked offline (buffer preserved for resume) |
| `resumeWindowMs` | `3600000` | How long an offline instance can still be resumed before hard-delete |
| `backfillSize` | `50` | Max agent_output messages buffered per instance |
| `rateLimitMessages` | `100` | Max messages per connection per window |
| `rateLimitWindowMs` | `10000` | Sliding window for message rate limiting |
| `maxMessageBytes` | `524288` | Max message size in bytes (512 KB) |
| `maxConnectionsPerIpPerMin` | `10` | Max new WebSocket connections per IP per minute |
| `maxConcurrentConnections` | `200` | Server-wide cap on concurrent WebSocket connections |

## Protocol

### Envelope format

Every message uses a standard envelope:

```json
{
  "v": 1,
  "type": "message_type",
  "ts": 1712841600000,
  "id": "uuid-v4",
  "payload": { }
}
```

### Message types

#### Authentication

| Type | Direction | Payload | Description |
|------|-----------|---------|-------------|
| `auth_request` | Client -> Server | `{ api_key, client_type }` | Authenticate as `"cli"` or `"pwa"` |
| `auth_response` | Server -> Client | `{ success, session_token }` | Auth result |

#### Instance management

| Type | Direction | Payload | Description |
|------|-----------|---------|-------------|
| `instance_register` | CLI -> Server | `{ name, agent_type, previous_session_token? }` | Register a CLI agent instance. Pass the previous `session_token` to resume a prior instance_id (ownership check). |
| `instance_registered` | Server -> All | `{ instance_id, resumed }` | Instance assigned (or resumed) |
| `instance_list` | Server -> PWA | `{ instances }` | List of active instances, each with `{ instance_id, name, agent_type, offline }` |
| `instance_offline` | Server -> PWA | `{ instance_id, name }` | Instance went offline |

#### Heartbeat

| Type | Direction | Payload | Description |
|------|-----------|---------|-------------|
| `instance_heartbeat` | CLI -> Server | `{ instance_id }` | Keep instance alive |
| `heartbeat_ack` | Server -> CLI | `{ instance_id }` | Heartbeat acknowledged |

#### Relay (CLI -> PWA)

| Type | Payload | Description |
|------|---------|-------------|
| `agent_output` | `{ instance_id, ... }` | Agent output stream |
| `approval_request` | `{ instance_id, ... }` | Tool approval prompt |
| `agent_status` | `{ instance_id, ... }` | Agent status change |

#### Relay (PWA -> CLI)

| Type | Payload | Description |
|------|---------|-------------|
| `user_input` | `{ instance_id, ... }` | User input injection |
| `approval_response` | `{ instance_id, ... }` | Approval decision |

#### Backfill

| Type | Direction | Payload | Description |
|------|-----------|---------|-------------|
| `request_backfill` | PWA -> Server | `{ instance_id }` | Request buffered output |
| `output_backfill` | Server -> PWA | `{ instance_id, entries }` | Buffered output messages |

#### E2E encryption

| Type | Direction | Payload | Description |
|------|-----------|---------|-------------|
| `key_exchange_offer` | CLI -> PWA | `{ instance_id, public_key }` | CLI public key offer |
| `key_exchange_accept` | PWA -> CLI | `{ instance_id, public_key }` | PWA public key response |
| `encrypted_message` | Bidirectional | `{ instance_id, nonce, ciphertext }` | Encrypted payload (server is passthrough) |

#### Errors

| Type | Direction | Payload | Description |
|------|-----------|---------|-------------|
| `error` | Server -> Client | `{ message }` | General error |
| `rate_limited` | Server -> Client | `{ message }` | Rate limit exceeded |
| `message_too_large` | Server -> Client | `{ message }` | Message exceeds size limit |

## Tech stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript (strict mode)
- **HTTP**: Express
- **WebSocket**: ws
- **Tests**: Vitest
- **Container**: Docker (Alpine)

## TODO

Findings from the WI-OPN-REVIEW audit (see `REVIEW-OPN-SERVER.md` at
the monorepo root for full analysis).

### Critical

- [x] **C1** — Real `api_key` authentication. `TAMER_API_KEY` env var is
  now required at startup (server exits if unset). Mismatching keys
  close the WebSocket with code `4003`. Pre-auth rate limiting is
  provided by the existing per-connection message rate limit + per-IP
  connection cap.

### High

- [x] **H1** — `cliInstances` value typed as
  `{ ws: WebSocket | null; info: CliInstance }`. `routeToCli` and
  related paths guard the null case.
- [x] **H2** — Resume now requires a `previous_session_token` in
  `instance_register` that matches the stored session token; otherwise
  a fresh `instance_id` is minted and the original owner keeps its
  resume window.
- [x] **H3** — `sweepHeartbeats` is now a two-pass sweep: online +
  stale → `markInstanceOffline`; offline past `resumeWindowMs`
  (default 1h) → hard delete via `removeInstance`.
- [x] **H4** — `ipConnectionLog` entries with empty timestamp arrays
  are dropped on access, and a periodic GC runs every 60s.
- [x] **H5** — A second `auth_request` on an already-authenticated
  connection returns an `error` and leaves `client_type` untouched.

### Medium

- [x] **M1** — README badge bumped to 0.6.0 in sync with
  `package.json`.
- [ ] **M2** — Document CORS posture. Accept a `CORS_ORIGIN` env var
  instead of the current `*`.
- [ ] **M3** — Document TLS deployment (Caddy / nginx / Cloud Run) and
  ship a sample `docker-compose.tls.yml`.
- [ ] **M4** — Strict envelope validation. Reject non-object `payload`
  before any handler accesses its fields.
- [ ] **M5** — Either verify `session_token` on subsequent messages
  (which would fix H2) or remove the field entirely.
- [ ] **M6** — `buildInstanceList` should expose `offline: boolean` or
  skip offline instances so PWAs don't try to route to them.
- [ ] **M7** — Add `USER node` to the Dockerfile; `node:22-alpine`
  ships a non-root user.
- [ ] **M8** — Declare a `HEALTHCHECK` in the Dockerfile against
  `/health`.
- [ ] **M9** — Flesh out `docker-compose.yml`: healthcheck, env
  overrides, resource limits, `read_only: true`.
- [ ] **M10** — Add `"engines": { "node": ">=22" }` to `package.json`.

### Low / polish

- [ ] **L1** — Add `"files": ["dist", "README.md", "LICENSE"]` to
  `package.json`.
- [ ] **L2** — Verify `.gitignore` covers `node_modules/`, `dist/`,
  `.env*`, `coverage/`.
- [ ] **L3** — Ship an `.env.example`.
- [ ] **L4** — Report JSON-parse failures distinctly from unknown
  envelope shapes.
- [ ] **L5** — Remove the committed `dist/` directory.
- [ ] **L6** — Document the meaning of WS close code 4008 in the
  Protocol section.
- [ ] **L7** — Consider splitting `/ready` from `/health`.
- [ ] **L8** — Add request logging (morgan or equivalent) and
  connection lifecycle logs.
- [ ] **L9** — Decide whether `agent_type` should be an allow-list or a
  free-form string; document the chosen posture.
- [ ] **L10** — Emit periodic `instance_list` refreshes, or document
  that PWAs must poll on reconnect.
- [x] **L11** — Regression tests added for C1 (wrong api_key rejected
  with 4003, apiKey required in config), H1 (PWA → offline instance
  does not crash), H2 (resume without or with wrong
  `previous_session_token` mints new id), H5 (second `auth_request`
  rejected, client_type unchanged). H3 two-pass sweep also covered.
- [ ] **L12** — Test the heartbeat `entry.ws !== ws` branch.
- [ ] **L13** — Test `maxMessageBytes` at the exact boundary (256 and
  257 for a 256-byte cap).
- [ ] **L14** — Clean up the `openSockets` array in each `connect()`
  wrapper's close handler.

## License

MIT
