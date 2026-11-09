# agents relay (Cloudflare Worker)

Opt-in relay between a Mac running Agentbox and a future iOS/watchOS client. The Mac pushes the same phone snapshots and command protocol as Supabase (`shared/phone-snapshot.mts`); the client lists **Needs you** threads, sends commands, and reads Mac status. No accounts—only bearer tokens.

Deploy target name: **`agents`** → `https://agents.<your-subdomain>.workers.dev` (this repo is set up for `agents.alstra11.workers.dev`).

## Why a Durable Object

Snapshots, the command queue, notify dedup, and Mac heartbeat belong in one place with single-writer semantics (claim before execute, mark done once). A Durable Object (`RelayRoom`) holds that state in SQLite-backed storage. KV would race on claims; D1 would need careful transactions across hot rows.

## Deploy (you run this locally)

```bash
cd relay
npm install
npx wrangler login   # once
npx wrangler secret put MAC_TOKEN      # Mac / Agentbox
npx wrangler secret put CLIENT_TOKEN   # iOS app
# optional defaults when the Mac does not send its own topic:
npx wrangler secret put NTFY_TOPIC
npx wrangler secret put NTFY_URL       # default https://ntfy.sh
npx wrangler deploy
```

Do **not** commit tokens. The Worker refuses `/mac/*` and `/client/*` without the right bearer.

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

| Role | Header |
|------|--------|
| Mac | `Authorization: Bearer <MAC_TOKEN>` |
| Client | `Authorization: Bearer <CLIENT_TOKEN>` |

Both roles send `X-Agentbox-Device: <12-hex id>` (the Mac uses its existing phone device id).

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
  "computerName": "MacBook"
}
```

`macOnline` is true when `macLastSeen` is within 120s.

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

**200** `{ "ok": true, "id": "<command-id>" }`  
**400** `{ "error": "<why>" }`

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

**200** `{ "commands": [ ... ] }` — waiting commands, oldest first.

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

From `relay/` (Worker, after `npm install`):

```bash
npm test
```
