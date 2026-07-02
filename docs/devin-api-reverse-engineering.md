# Devin API Reverse Engineering Notes

Status: lab notes for issue #197. Do not treat this as production enablement.

## Goal

Reverse engineer the Devin cloud path the same way this repo reverse engineered Windsurf Cascade:

1. Mine the shipped client and local cache.
2. Identify auth, transport, endpoint, and message schema.
3. Confirm with safe probes that do not create real cloud sessions unless explicitly intended.
4. Add a narrow, gated backend behind the existing OpenAI-compatible chat route.

## Evidence gathered

### Local Devin install

Verified local CLI:

- Binary: `/home/brandon/.local/share/devin/cli/_versions/2026.5.26-8/bin/devin`
- Docs: `/home/brandon/.local/share/devin/cli/_versions/2026.5.26-8/share/devin/docs/`
- Manpages: `/home/brandon/.local/share/devin/cli/_versions/2026.5.26-8/share/man/man1/`
- User config: `/home/brandon/.config/devin/config.json`
- Credentials: `/home/brandon/.local/share/devin/credentials.toml`
- Cached model config: `/home/brandon/.cache/devin/cli/model_configs.bin`
- Cached model config v2: `/home/brandon/.cache/devin/cli/model_configs_v2.bin`
- Team settings cache: `/home/brandon/.cache/devin/cli/team_settings.bin`
- Session DB: `/home/brandon/.local/share/devin/cli/sessions.db`

Credentials file contains these keys, with secrets redacted during inspection:

```toml
windsurf_api_key = "<redacted>"
api_server_url = "https://server.codeium.com"
devin_webapp_host = "app.devin.ai"
devin_api_url = "https://api.devin.ai"
```

`devin auth status` confirms the local account is logged in through Devin, has Devin Pro, and team settings allow 95 models.

### Model catalog evidence

`model_configs_v2.bin` contains these current special-agent model IDs:

- `swe-1-6`
- `swe-1-6-fast`
- `kimi-k2-7`
- `glm-5-2`
- plus current Claude/GPT/Gemini model families.

`team_settings.bin` contains allowed model IDs including:

- `swe-1-6`
- `swe-1-6-fast`
- `kimi-k2-7`
- `glm-5-2`
- many Claude Opus/Sonnet, GPT, Gemini, Kimi, GLM variants.

This confirms the model list is not just static docs. It is cached from upstream CLI model config.

### Auth and protocol split

The CLI uses two upstream surfaces:

1. Windsurf/Codeium Connect-RPC for account status and model config:
   - `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs`
   - `https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus`
   - credential key: `windsurf_api_key`

2. Devin cloud API for cloud/remote agent sessions:
   - host from credentials: `https://api.devin.ai`
   - cloud ACP transport discovered in binary/log strings: `wss://api.devin.ai/acp/live?token=...`
   - REST session status endpoint evidence from binary strings/logs: `/sessions`, `/sessions?session_ids=`, `/sessions/{id}`

Important: the Windsurf session token is accepted for some Devin API probes but is not enough for all Devin cloud endpoints.

Safe probes returned:

```text
GET https://api.devin.ai/sessions
-> 405 {"detail":"Method Not Allowed"}

POST https://api.devin.ai/sessions {}
-> 401 {"detail":"Unauthenticated"}

GET https://api.devin.ai/sessions/fake-session-id
-> 403 {"detail":"This endpoint is not accessible with a Windsurf session token"}

POST https://api.devin.ai/auth/cli/token {}
-> 422 missing body fields: code, code_verifier
```

Interpretation:

- `/sessions` is real and likely POST-only for creation.
- `/sessions/{id}` is real and distinguishes token class.
- The stored `windsurf_api_key` is a Windsurf session token, not the full Devin cloud session token required for `/sessions` create/status access.
- `/auth/cli/token` is the PKCE exchange endpoint for real Devin API credentials. It requires `code` and `code_verifier`.

### ACP cloud transport evidence (from CLI)

Binary strings and local logs show the handoff flow does not primarily use an OpenAI chat endpoint. It connects to a cloud ACP websocket:

```text
/acp/live?token=
[handoff] connect_acp: connecting
[handoff] connect_acp: connected
[handoff] connect_acp: initialize sent
[handoff] connect_acp: initialize response received
[handoff] connect_acp: handshake complete
session/new
session/prompt
```

The initialize response seen in logs exposes capabilities:

```json
{
  "agentInfo": { "name": "devin", "title": "Devin", "version": "1.0.0" },
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {
      "audio": true,
      "embeddedContext": true,
      "image": true
    },
    "sessionCapabilities": { "list": {} }
  }
}
```

### ACP cloud transport evidence (from Devin Desktop -- canonical source)

Devin Desktop (Windsurf IDE bundled with Devin) ships a production-grade ACP websocket connector in its extension bundle. This is the best single reference implementation for cloud ACP. Source: `/home/brandon/Documents/Devin/resources/app/` (Electron + Windsurf extension bundle, v1.110.1).

**WebSocket URL construction (RemoteAcpConnector class, in minified `extension.js`):**

The agent `"devin-cloud"` gets its websocket URL from the ACP registry:

```text
wss://app.devin.ai/api/acp/live
```

Before connecting, Desktop rewrites the host to use the user's configured `webappHost` (from `planInfo.devinInfo.webappHost` in the metadata status) and appends the session token as a query parameter:

```text
wss://<webappHost>/api/acp/live?token=<session-token>
```

For self-hosted/enterprise, this allows routing to a different host. For `localhost`/`127.0.0.1` hosts it uses `ws:` instead of `wss:`.

**Session token resolution (RemoteAcpConnector._ensureDevinSessionToken):**

Three-tier fallback:

1. If the stored Windsurf API key already starts with the Devin session token prefix (`"devin-"`), use it directly.
2. If `_cachedSessionToken` is non-null, return that (prevents redundant token mints).
3. Otherwise, call `fetchSelfDevinSessionToken(apiKey)` -- exchanges the Windsurf API key for a Devin session token via an internal Codeium server method (gRPC/Connect), then caches the result.

This means Desktop does NOT hit `/auth/cli/token` for its token. It uses an internal Codeium server exchange (`GetSelfDevinSessionToken`). This is the same `fetchSelfDevinSessionToken` function used elsewhere in the extension for eligible-org lookups.

**Confirmed token exchange (safe probe):**

```text
POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetSelfDevinSessionToken
Content-Type: application/proto
Accept: application/proto
X-Api-Key: <windsurf_api_key>
Body: GetSelfDevinSessionTokenRequest { metadata = field 1 }
Response: GetSelfDevinSessionTokenResponse { session_token = field 1 }
```

Generated protobuf evidence from Desktop bundle:

```text
GetSelfDevinSessionTokenRequest:
  field 1 metadata: exa.Metadata

GetSelfDevinSessionTokenResponse:
  field 1 session_token: string
```

Live safe probe results:

```text
raw unary application/proto -> HTTP 200, responseBytes=192, tokenPrefixOk=true, tokenLength=189
framed application/connect+proto -> HTTP 415
```

No prompt was sent and no websocket was opened during this probe.

**Connection lifecycle (RemoteAcpConnector.connect):**

1. Resolve the session token.
2. Build the authenticated URL (host rewrite + `?token=`).
3. Open a raw WebSocket (`new WebSocket(url)` using the `ws` npm module).
4. On `"open"`: create the ACP message stream via `webSocketStream(ws)` from `@exa/windsurf-acp`, then call `this.initialize()`.
5. On `"close"`: exponential backoff reconnect (1s * 2^attempts, max 60s, auto-stop after ceiling).
6. On `"error"`: set status `"disconnected"`.

**Connection status states:** `connecting`, `connected`, `reconnecting`, `disconnected`, `disabled`.

**ACP-level authentication (RegistryAcpConnector._authenticateWithWindsurfApiKey):**

After ACP `initialize`, the bundled agent connector sends an explicit `authenticate` ACP request:

```json
{
  "method": "authenticate",
  "params": {
    "methodId": "windsurf-api-key",
    "_meta": {
      "api_key": "<windsurf-api-key>",
      "api_server_url": "https://server.codeium.com"
    }
  }
}
```

This happens for the bundled (locally spawned via CLI) agent. For the remote Devin Cloud agent, authentication is implicit via the `?token=` query parameter on the WebSocket URL.

**Full Desktop connect flow (for Devin Cloud):**

```
1. Resolve session token: fetchSelfDevinSessionToken(apiKey)
2. Build URL: wss://<webappHost>/api/acp/live?token=<session-token>
3. WebSocket connect to that URL
4. ACP initialize (JSON-RPC over websocket)
5. (Optionally authenticate if agent requires it)
6. session/new -> session/prompt
```

**Relevant source files in the Desktop bundle:**

- `extensions/windsurf/dist/extension.js` -- RemoteAcpConnector class (~200 lines of minified JS), contains the full connect/auth/reconnect logic.
- `node_modules/@exa/windsurf-acp/index.js` -- ACP SDK library with WindsurfAcpConnection, webSocketStream, ndJsonStream, ClientSideConnection, all ACP method routing, and Zod schemas for every ACP message type.
- `node_modules/@exa/chat-client/index.js` -- The Windsurf chat client that renders sessions. Not the transport layer, but contains the `/sessions/` URL reference and `//acp/session?sessionId=` fragment.

**Key ACP methods supported (from @exa/windsurf-acp schema):**

`authenticate`, `document/didChange`, `document/didClose`, `document/didFocus`, `document/didOpen`, `document/didSave`, `initialize`, `logout`, `nes/accept`, `nes/close`, `nes/reject`, `session/close`, `session/fork`, `session/list`, `session/load`, `session/new`, `session/prompt`, `session/resume`, `session/set_config_option`, `session/set_mode`, `session/set_model`.

Plus Windsurf-specific extension methods (cognition.ai/*) for: revert, MCP management, session rename, PR management, secrets, etc.

This makes the first native backend target clearer: implement a Devin ACP websocket client following the Desktop reference, not a fake OpenAI REST chat client.

### ACP JSON-RPC shape

The local CLI already implements ACP over stdio in `devin acp`, and logs show cloud ACP also speaks JSON-RPC. Observed method names:

- `initialize`
- `notifications/initialized`
- `session/new`
- `session/prompt`
- `session/set_config_option`

Observed prompt payload errors from bad probes are useful because they reveal the expected content block schema:

```text
unknown variant `user`, expected one of `text`, `image`, `audio`, `resource_link`, `resource`
missing field `type`
missing field `text`
```

So a minimal prompt content item is likely:

```json
{ "type": "text", "text": "..." }
```

Not:

```json
{ "role": "user", "content": "..." }
```

### Session persistence evidence

`~/.local/share/devin/cli/sessions.db` has local tables:

- `sessions(id, working_directory, backend_type, model, agent_mode, created_at, ...)`
- `prompt_history(id, content, timestamp, session_id, is_shell)`
- `message_nodes(row_id, session_id, node_id, parent_node_id, chat_message, created_at, metadata)`
- `tool_call_state(session_id, tool_call_id, tool_call_json, tool_call_update_json)`

Local sessions seen there use:

- `backend_type = Windsurf`
- `model = swe-1-6-fast`

That tells us local CLI can run SWE models through the Windsurf-backed local agent path, while `/handoff`/cloud uses the Devin API websocket path.

## What WindsurfAPI already does that we should copy

Existing reverse engineering pattern in this repo:

- `src/proto.js` provides schema-less protobuf encoding/decoding.
- `src/grpc.js` wraps gRPC/Connect transport and traces payloads.
- `src/windsurf.js` encodes the Cascade request chain: `StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps`.
- `docs/native-bridge-protocol-notes.md` records field numbers, runtime traces, canary results, and stop-loss conclusions.
- `src/cascade-native-bridge.js` keeps protocol mappings gated and narrow until runtime evidence proves stability.

The Devin equivalent should follow the same discipline:

- `src/devin-api.js` or `src/devin-cloud-acp.js` for protocol transport.
- `docs/devin-api-reverse-engineering.md` for field/endpoint evidence.
- A lab-only env gate before any production routing.
- A smoke script that can prove one narrow request shape works.
- Tests around routing and payload shaping before enabling it for real callers.

## Current repo integration seam

Existing special-agent seam:

- `src/special-agent.js`
  - `handleSpecialAgentChatCompletion(...)`
  - `runDevinPrint(...)`
  - `runDevinAcp(...)`
  - enabled by `WINDSURFAPI_SPECIAL_AGENT_BACKEND=devin-cli`
  - mode selected by `DEVIN_CLI_MODE=print|acp`
- `src/handlers/chat.js`
  - imports and routes to `handleSpecialAgentChatCompletion(...)` before ordinary Cascade routing for special models.
- `test/special-agent-routing.test.js`
  - covers SWE/adaptive route marking, special-agent routing, ACP mode, tool/media rejection, and stream buffering.
- `scripts/special-agent-smoke.mjs`
  - hits `/health?verbose=1`, then `/v1/chat/completions` with `swe-1.6-fast`.

This means the first direct API implementation should not touch normal Cascade code. It should add a new backend mode under the special-agent path.

## Recommended first PR slice

Do not jump straight to tool bridging. The useful narrow slice is:

1. Add `DEVIN_CLOUD_MODE=acp-ws` or `DEVIN_CLI_MODE=cloud-acp` as an explicitly gated lab backend.
2. Reuse the confirmed token helper:
   - `src/devin-session-token.js`
   - `scripts/devin-session-token-probe.mjs`
   - `GetSelfDevinSessionToken` raw unary `application/proto` call
3. Implement cloud ACP handshake only:
   - mint/accept a Devin session token,
   - use the registry URL from `GetAllAcpRegistries` (`wss://app.devin.ai/api/acp/live` as of 2026-06-21),
   - rewrite host to `planInfo.devinInfo.webappHost`,
   - strip the `devin-` prefix before adding the websocket `?token=` query param (Desktop behavior),
   - send `initialize`,
   - verify `agentInfo.name === "devin"`,
   - close cleanly.
4. Add a smoke script that reports:
   - token class and length only (never token bytes),
   - websocket connection status,
   - initialize result summary,
   - no prompt sent unless `DEVIN_CLOUD_SEND_PROMPT=1`.
5. Current lab implementation exists:
   - `src/devin-cloud-acp.js`
   - `scripts/devin-cloud-acp-handshake-smoke.mjs`
   - `test/devin-cloud-acp.test.js`
6. Only after handshake works, add `session/new` and `session/prompt` with text-only content:
   - `{ "type": "text", "text": prompt }`
   - no tools,
   - no media,
   - no local file access.
7. Wrap resulting text as OpenAI-compatible non-streaming chat response.
8. Keep streaming as buffered or unsupported until event notification schema is mapped.

## Known blockers

- `/sessions` REST remains a different surface. The Windsurf API key is not sufficient for `/sessions` create/status access. It returns `401` on `POST /sessions` and `403` on `GET /sessions/{id}`.
- Cloud ACP token minting is confirmed and implemented locally via `GetSelfDevinSessionToken`; it does not require the `/auth/cli/token` PKCE path.
- Registry discovery is confirmed: `GetAllAcpRegistries` on `exa.cascade_plugins_pb.CascadePluginsService` returns `devin-cloud.distribution.websocket.url = wss://app.devin.ai/api/acp/live`.
- Desktop URL construction is confirmed from the shipped bundle: rewrite host to `planInfo.devinInfo.webappHost`, force `wss:` unless localhost, strip `devin-`, then set `token` query param.
- Live direct cloud ACP handshake is still blocked before ACP code runs. `scripts/devin-cloud-acp-handshake-smoke.mjs` sends no prompt and creates no session, but Node 22 global WebSocket receives `ERR_WS_OPEN_ERROR`; the paired manual upgrade probe returns `403 Forbidden`, `x-cache: Error from cloudfront`, `content-type: text/plain`.
- The same `403` result occurs with both `~/.local/share/devin/credentials.toml` and Devin Desktop's current plaintext `windsurfAuthStatus.apiKey` token from `~/.config/Devin/User/globalStorage/state.vscdb` (validated by length/hash only; token bytes not logged).
- Devin Desktop itself connected successfully today to the same visible URL and initialized, so the remaining missing piece is below ACP protocol level: likely runtime-specific WebSocket handshake shape, CloudFront allow-list behavior, or an app/session coupling not represented by the token query alone.
- Do not send `session/new` or `session/prompt` until handshake-only smoke passes.

## Stop-loss decision

Cloud ACP token generation is no longer the blocker. The stop-loss now moves one layer downstream: if websocket `initialize` cannot be reproduced cleanly with the minted session token, keep the shipped backend as `devin acp` stdio and do not pretend direct cloud ACP support exists.
