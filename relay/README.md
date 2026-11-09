# agents relay (Cloudflare Worker)

Opt-in relay between a Mac running Agentbox and the iPhone and Watch clients. The Mac pushes the same phone snapshots and command protocol as Supabase (`shared/phone-snapshot.mts`); a client lists **Needs you** threads, sends commands, and reads Mac status. Cloud agent sessions live on the same Durable Object, so a client can start and answer a Cursor cloud agent while the Mac is off. No accounts—only bearer tokens.

Deploy target name: **`agents`** → `https://agents.<your-subdomain>.workers.dev` (this repo is set up for `agents.alstra11.workers.dev`).

## Why a Durable Object

Snapshots, the command queue, notify dedup, and Mac heartbeat belong in one place with single-writer semantics (claim before execute, mark done once). A Durable Object (`RelayRoom`) holds that state in SQLite-backed storage. KV would race on claims; D1 would need careful transactions across hot rows.

## Deploy (you run this locally)

```bash
cd relay
npm install
npx wrangler login   # once
npx wrangler secret put MAC_TOKEN      # Mac / Agentbox — /mac/* only
npx wrangler secret put IPHONE_TOKEN   # iOS app — /client/* only
npx wrangler secret put WATCH_TOKEN    # watchOS app — /client/* only
npx wrangler secret put CURSOR_API_KEY # Cloud Agents API key — never logged
# optional defaults when the Mac does not send its own topic:
npx wrangler secret put NTFY_TOPIC
npx wrangler secret put NTFY_URL       # default https://ntfy.sh
npx wrangler deploy
```

Do **not** commit tokens. Tokens are compared in constant time. A client token is rejected on `/mac/*`; the Mac token is rejected on `/client/*`.

### Rotating one device

Generate a new random secret, update it, and roll only that app:

```bash
# Example: new Watch token without touching Mac or iPhone
npx wrangler secret put WATCH_TOKEN
# Update the watch app’s stored token, then release. Mac and iPhone keep working.
```

To revoke a lost phone: `wrangler secret put IPHONE_TOKEN` with a new value (or remove the app’s copy of the old token). The Mac token and the other client token stay valid.

## Mac setup (`zero.config.json`)

```json
{
  "relay": {
    "url": "https://agents.alstra11.workers.dev",
    "macToken": "same-as-MAC_TOKEN-secret",
    "ntfyTopic": "your-private-topic",
    "ntfyUrl": "https://ntfy.sh",
    "projects": ["my-app"]
  }
}
```

- Omit `projects` to use the same phone project choice as cloud (`phoneProducts`); default is all eligible projects.
- Set `"relay": { "on": false }` to turn the relay off without removing the block.
- While Agentbox runs, it syncs about every 30s: snapshots up, commands down through `main/phone-inbox.mts`.
- When the Mac sleeps, sync stops; **commands stay queued** on the relay until the Mac wakes and claims them.
- ntfy: on each thread batch that newly enters Needs you, the Worker POSTs once (deduped by status + `updatedAt` + question text). Configure the topic on the phone with the ntfy app (see below).

## Auth

| Caller | Token secret | Routes |
|--------|----------------|--------|
| Agentbox Mac | `MAC_TOKEN` | `/mac/*` only |
| iPhone app | `IPHONE_TOKEN` | `/client/*` only |
| Watch app | `WATCH_TOKEN` | `/client/*` only |

Header: `Authorization: Bearer <token>`. Both Mac and clients send `X-Agentbox-Device: <12-hex id>` (the Mac uses its existing phone device id). A client command is stored under the client's id. `GET /mac/commands` returns every command still waiting, so a reply from the iPhone or the Watch reaches the Mac even when the two ids differ.

Each queued command carries `source: "iphone" | "watch"` so the Mac log and command payload (`relaySource`) show which client sent it.

## HTTP API (for the SwiftUI client)

Base URL: relay `url` above. All JSON bodies UTF-8. Watch-friendly payloads: Needs-you list items are short strings, options capped by what the Mac already trimmed in snapshots.

### `GET /health`

No auth. `{ "ok": true }`

### Client

#### `GET /client/needs-you`

**200** `{ "items": [ NeedsYouItem, ... ] }`

`NeedsYouItem`:

| Field | Type | Notes |
|-------|------|--------|
| `project` | string | slug |
| `projectName` | string | |
| `id` | string | thread id |
| `title` | string | |
| `status` | string | |
| `kind` | string? | |
| `updatedAt` | number | ms |
| `context` | string | short body excerpt |
| `question` | string | one line for Watch |
| `options` | `{ n, text, recommended }[]` | numbered picks |
| `hasApproval` | boolean? | permission card |
| `wait` | object? | queue/sign-in state from snapshot |

#### `GET /client/projects`

**200** `{ "projects": [{ "slug", "name", "cloud", "updatedAt" }] }`

#### `GET /client/threads/:project/:item`

**200** `{ "snapshot": ThreadSnapshot }` — same shape as `shared/phone-snapshot.mts` (`v`, `item`, `history`, `olderLines`, optional `live`, `approvals`, `wait`).

**404** if unknown.

#### `GET /client/status`

**200**

```json
{
  "macLastSeen": 1710000000000,
  "macOnline": true,
  "paused": false,
  "stalled": ["w-..."],
  "queue": { "runNow": [], "queued": [] },
  "version": "0.1.22",
  "computerName": "MacBook",
  "harnesses": [{ "id": "claude", "label": "Claude Code", "available": true }]
}
```

`macOnline` is true when `macLastSeen` is within 90s (the Mac heartbeat is about every 30s). `harnesses` is empty until the Mac reports one, and `available` follows `macOnline`.

#### `POST /client/commands`

Body: phone command (see `PHONE_COMMANDS` in `shared/phone-snapshot.mts`):

```json
{
  "id": "optional-uuid",
  "kind": "reply",
  "project": "my-app",
  "item": "w-abc1234567",
  "payload": { "text": "Ship it" }
}
```

Kinds: `reply`, `new`, `snooze`, `close`, `stop`, `run-now`, `send-now`, `reopen`, `schedule`, `approve`, `setting`, `move-to-cloud` (same validation as the Mac).

`new` takes an optional `target` (`cloud` or `local`, default `cloud`) and `provider` (default `cursor`). They may sit on the command or in `payload`. A cloud `new` also needs `payload.repo` (`https://…` repository URL), `payload.body` (the prompt), and may set `payload.startingRef` and `payload.model`. `autoCreatePR` defaults to true.

**200** `{ "ok": true, "id": "<command-id>" }`. A cloud command also returns `sessionId`, `target`, and `provider`.  
**400** `{ "error": "<why>" }`  
**409** `{ "error": "mac_offline" }` when `target` is `local` and the Mac has not been seen in 90s.  
**503** `{ "error": "cursor_unconfigured" }` when `CURSOR_API_KEY` is missing.

Cloud is the default. `target: "local"` is the existing Mac queue. The Mac's `GET /mac/commands` only returns commands for local work; a cloud reply, stop, close, or approval is handled on the relay and never claimed by the Mac.

| Cloud command | Cursor API |
|---------------|------------|
| `reply`, option text, `approve` | `POST /v1/agents/{id}/runs`. If a run is active, `delivery: "steer"` (a 409 on a plain follow-up steers too). |
| `stop` | `POST /v1/agents/{id}/runs/{runId}/cancel` |
| `close`, or the option Schließen | `POST /v1/agents/{id}/archive` |

The create prompt asks the agent to end a turn that needs a decision with one line, `NEEDS_YOU{"question","options":[{"text","recommended"}]}`. The relay parses the last valid block.

#### `GET /client/targets`

**200**

```json
{
  "macOnline": true,
  "computerName": "MacBook",
  "defaultTarget": "cloud",
  "harnesses": [{ "id": "claude", "label": "Claude Code", "available": true }],
  "targets": [
    { "target": "cloud", "provider": "cursor", "label": "Cloud · Cursor", "available": true },
    { "target": "local", "provider": "mac", "label": "Lokal · MacBook", "available": true }
  ]
}
```

`harnesses` is what the Mac last reported (`claude`, `codex`). Each one is `available` only while `macOnline`. The same `harnesses` array is on `GET /client/status`. A local target is `available` only while the Mac is online.

Every Needs-you item and thread snapshot includes `target` (`cloud` or `local`) and `provider` (`cursor`, or the computer name for a Mac thread).

### Cloud runs

`RelayRoom` stores a session per cloud agent: id, project, provider, target, Cursor agent id, run id, status, branch, prUrl, the device that started it, timestamps. An open needs-you row belongs to that session (`question`, `approval`, `review`, `error`) and carries the question, options, recommended, and answer.

An alarm every 30s polls runs that are still going (`GET /v1/agents/{id}/runs/{runId}`). `FINISHED` with a `NEEDS_YOU` block becomes a question. `FINISHED` without one becomes a review (Zusammenführen / Weiter / Schließen, and the PR url when Cursor returned one). `ERROR` and `EXPIRED` become an error (Nochmal / Weiter). `CREATING`, `RUNNING`, `WAITING_FOR_BACKGROUND_WORK`, and any other non-terminal status do not ask. Each new needs-you row is pushed once through the existing ntfy path. Click is `agentbox://thread/<session id>?project=<slug>`.

Auth to Cursor is HTTP Basic with `CURSOR_API_KEY` as the username and an empty password. The key is not written to logs or to error bodies.

`openai-agents`, `codex-cli`, and `claude-managed` are named on the provider interface and refused with `provider_unavailable`. They are not implemented.

### Mac

#### `PUT /mac/project`

`{ "project", "name", "cloud"?: boolean }`

#### `DELETE /mac/project?project=<slug>`

#### `PUT /mac/threads`

`{ "project", "threads": [{ "item", "snapshot" }] }`  
May trigger ntfy for newly Needs-you threads. **200** `{ "ok": true, "notified": <n> }`

#### `DELETE /mac/threads?project=<slug>&item=<id>&item=<id>...`

#### `PUT /mac/status`

Mac queue snapshot: `{ "at", "paused"?, "stalled"?, "queued"?, "runNow"?, "version"?, "computerName"? }`

#### `PUT /mac/settings`

`{ "settings": <phone settings blob>, "ntfy"?: { "url", "topic" } }` — optional per-Mac ntfy override.

#### `GET /mac/commands`

**200** `{ "commands": [ ... ] }` — every command still waiting, oldest first, whichever client device posted it. Each row includes `source` (`"iphone"` or `"watch"`) and `device` (the client's `X-Agentbox-Device`).

#### `POST /mac/commands/:id/claim`

**200** `{ "claim": "claimed" | "ours" | "gone" }`

#### `POST /mac/commands/:id/done`

`{ "outcome": "done" | "refused: ..." }` → **200** `{ "ok": true|false }`

## ntfy on iPhone

1. Install [ntfy](https://ntfy.sh) or use a self-hosted server (`ntfyUrl`).
2. Subscribe to the same **topic** as in `zero.config.json` / Worker secret (pick an unguessable name).
3. Worker posts: **Title** = thread title, **body** = question line, **Priority** = high, **Click** = `agentbox://thread/<id>?project=<slug>` for the native app.
4. Duplicate pushes are suppressed until the question/status stamp changes.

## Tests

From repo root (logic + Mac client):

```bash
npm run test:changed relay shared/relay main/relay
```

From `relay/` (the same vitest files, after `npm install` at the repo root):

```bash
npm test
```
