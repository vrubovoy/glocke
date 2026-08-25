# Glocke

[![Test](https://github.com/zudaR107/glocke/actions/workflows/test.yml/badge.svg)](https://github.com/zudaR107/glocke/actions/workflows/test.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

Part of the [Hof platform](https://github.com/zudaR107/Hof), a suite of
self-hosted personal services:

- [`schloss`](https://github.com/zudaR107/schloss) - home page / launcher
- [`schlussel`](https://github.com/zudaR107/schlussel) - auth: accounts, login, tokens
- [`kuvert`](https://github.com/zudaR107/kuvert) - envelope budgeting
- [`tafel`](https://github.com/zudaR107/tafel) - task/project tracking
- [`zettel`](https://github.com/zudaR107/zettel) - markdown note-taking
- **`glocke`** (this repo) - in-app notification center and delivery foundation
- [`schrank`](https://github.com/zudaR107/schrank) - file storage with nested folders
- [`herold`](https://github.com/zudaR107/herold) - webmail client for external IMAP/SMTP accounts
- [`wachter`](https://github.com/vrubovoy/wachter) - server resource monitoring
- [`tor`](https://github.com/zudaR107/tor) - reverse-proxy gateway
- [`schloss-ui`](https://github.com/zudaR107/schloss-ui) - shared frontend components
- [`schloss-server-kit`](https://github.com/zudaR107/schloss-server-kit) - shared backend auth/CORS and notification transport helpers

Glocke is a pnpm workspace containing a Hono/Drizzle/SQLite backend and a
React frontend. Shared auth, transport, and UI come from the
`schloss-server-kit` and `schloss-ui` submodules.

## Architecture

- Producers send a shared v1 envelope to `POST /internal/v1/events`. The exact
  raw body is authenticated with `X-Hof-Service`, `X-Hof-Key-Id`,
  `X-Hof-Timestamp`, and `X-Hof-Signature`, using one dedicated credential per
  configured producer.
- Glocke verifies the signature and strict envelope before writing the event;
  unknown top-level or payload fields are rejected. The
  durable inbox primary key is `(source, event_id)`: a newly stored body
  returns `202`, an exact byte-for-byte replay returns `200`, and reuse of the
  same identity with different bytes returns `409`.
- A background worker claims inbox rows with expiring, fenced leases. The
  unique key `(source, event_id, user_id)` permits at most one stored in-app
  notification for an event and recipient, including when a worker retries
  after creating the notification but before completing the inbox row. Fresh
  lease checks fence both materialization and subsequent inbox completion.
- Before materialization, Glocke makes a separately signed internal request to Schlüssel and uses the recipient's current `notifyInApp` value. Disabled delivery and deleted recipients are suppressed and completed.
- Public routes derive ownership only from the verified JWT. They provide cursor pagination, unread count, read, read-all, and delete. Outermost middleware makes every `/notifications*` response, including preflight, body-limit, authentication, and routing responses, private, no-store, no-cache, and nosniff.
- The shared Hof `Header` displays a Glocke bell and polls the unread count through its auth-safe shared hook. Glocke uses the same-origin `/backend` client and invalidates the shared count after successful read, read-all, and delete mutations.
- `GET /exports/me` returns a standardized versioned JSON snapshot containing every caller-owned notification and its read state. It accepts either a normal Glocke access token or a Schlüssel export delegation scoped to `data:export` with the exact `hof-service:glocke` audience. Inbox payloads and hashes, worker leases, local user rows, and runtime credentials are never included.
- SQLite starts in WAL mode with foreign-key enforcement and runs generated Drizzle migrations before serving.

The current end-to-end producer is Schlüssel. A password change and its outbox
event commit in the same Schlüssel SQLite transaction. Its leased dispatcher
retries timeout, network, `408`, `425`, `429`, and `5xx` failures with bounded
full-jitter backoff, and treats any `2xx` response from Glocke as delivered.
After the configured attempt limit, or after a permanent response, the outbox
row is retained in a terminal `permanent` state for operations to inspect.

This is **not an exactly-once protocol**. A response can be lost after Glocke
has committed an event, so producers use stable event IDs and may deliver the
same bytes more than once. The producer outbox makes durable,
at-least-once-style attempts, but those attempts are bounded: a terminal
`permanent` row means eventual delivery is not guaranteed. Glocke's inbox and
notification unique keys make retries idempotent. These guarantees cover
database state, not an exactly-once observation by clients or future external
delivery channels.

## Data exports

`GET /exports/me` is a synchronous direct Glocke JSON export, used both by the
Settings download and as an input to Schlüssel's separate asynchronous
all-services ZIP. Its strict version 1 envelope contains all user-visible
notifications owned by the verified subject, without pagination, including
read state. The query runs when the request reaches Glocke; it is not a
platform-wide point-in-time snapshot.

The endpoint accepts an ordinary access token or a JWKS-verified RS256
delegation with the configured exact issuer, `token_use: export`, the single
`hof-service:glocke` audience, `data:export` scope, and nonempty subject, job,
and token IDs plus a non-expired numeric `exp`. Delegations are accepted only
here, and the subject comes from the verified token rather than request data.
Responses are private, no-store, and nosniff.

Only Schlüssel's `/export-jobs` creates the ZIP. Services snapshot
independently, so timestamps can differ; retrying failed services preserves
successful files and captures retries later. If at least one service succeeds
and at least one fails, the job produces a partial archive. `manifest.json`
records status, attempts, files, timestamps, byte counts, SHA-256 checksums,
and sanitized failures.

The ZIP is an authenticated owner-only no-store download. It expires after a
short TTL (24 hours by default) and is bounded by per-user cooldown and
retention caps, response-size limits, a global storage quota, and a free-space
reserve. Export files are sensitive: Glocke includes notification titles,
bodies, actions, sources, and read state, but excludes inbox envelopes and
payload hashes, suppressed events, leases, local user rows, HMAC/JWT material,
runtime configuration, logs, other users, and other services' data.

## Internal v1 envelope

```json
{
  "version": "1",
  "id": "1a9ca2e4-0583-4f31-927d-47b387b94700",
  "type": "schlussel.security.password_changed.v1",
  "source": "schlussel",
  "occurredAt": "2026-08-07T10:00:00.000Z",
  "correlationId": "2735707b-b633-454d-899a-6562d611a8c7",
  "payload": { "recipientId": "user-id" }
}
```

Signatures use HMAC-SHA-256 from `@zudar107/schloss-server-kit`. The signed
canonical value is the newline-joined sequence below. The shared signer emits a
lowercase hexadecimal HMAC; verification accepts exactly 64 hexadecimal
characters case-insensitively:

```text
<Unix timestamp in integer seconds>
<uppercase HTTP method>
<request path including query string>
<lowercase SHA-256 hex of the exact body bytes>
<key id>
<source service name>
```

Producers must sign the final bytes and send those same bytes; parsing and
reserializing JSON, including changing insignificant whitespace, invalidates
the signature. Glocke also checks the configured source, key ID, and timestamp
window before accepting the request. HMAC supplies request authentication and
integrity, not encryption, and does not by itself prevent a replay inside the
timestamp window. The durable event identity handles such replays after the
first commit. The default maximum body is 64 KiB and timestamp skew is 300
seconds.

`schlussel.security.password_changed.v1` deliberately carries only `recipientId`. Glocke owns its Russian title, body, and account-settings action. Intake never calls Schlüssel: recipient existence and the current `notifyInApp` preference are resolved only after a durable inbox claim. A missing recipient is durably suppressed and marked processed.

### Event registry

`backend/src/event-registry.ts` is the single source of truth for every `(source, type)`
pair this deployment accepts: it drives payload validation at intake, Russian
rendering at processing, the seven `oneOf` request-body contracts in
`GET /openapi.json`, and (via `GLOCKE_EVENT_SOURCES`) which producer secrets
`loadConfig` will even accept. There is no producer-rendered fallback — an
envelope whose type isn't registered, or whose source doesn't own that type,
is rejected with `400` before its payload is even looked at, and a payload
carrying `title`/`body`/`actionUrl` is always rejected (every payload schema
is `.strict()`; presentation is Glocke's alone). The seven currently
registered events:

| Type | Source | Payload | Rendered action |
|---|---|---|---|
| `schlussel.security.password_changed.v1` | `schlussel` | `recipientId` | `/settings` |
| `kuvert.goal.completed.v1` | `kuvert` | `recipientId`, `goalName` | `<KUVERT_ORIGIN>/goals` |
| `kuvert.debt.paid_off.v1` | `kuvert` | `recipientId`, `counterparty` | `<KUVERT_ORIGIN>/debts` |
| `kuvert.envelope.overdrawn.v1` | `kuvert` | `recipientId`, `envelopeName` | `<KUVERT_ORIGIN>/budget` |
| `tafel.task.due.v1` | `tafel` | `recipientId`, `taskTitle`, `dueDate`, `overdue` | `<TAFEL_ORIGIN>/tasks` |
| `tafel.project.completed.v1` | `tafel` | `recipientId`, `projectName` | `<TAFEL_ORIGIN>/projects` |
| `zettel.note.backlink_added.v1` | `zettel` | `recipientId`, `sourceTitle`, `targetTitle` | none |

## Local development

```sh
git submodule update --init
pnpm install
pnpm --filter @zudar107/schloss-server-kit build
pnpm --filter @zudar107/schloss-ui build
pnpm dev:backend    # http://localhost:3004
pnpm dev:frontend   # http://localhost:5177
```

The backend requires a running Schlüssel API for JWKS and recipient lookups.
It does not load `.env`; export runtime variables in the backend terminal.
`.env.example` primarily names Docker Compose substitutions and includes the
corresponding direct-run names in comments. A minimal direct setup is:

```sh
export DATABASE_PATH=./data/glocke.db
export SCHLUSSEL_JWKS_URL=http://localhost:4000/.well-known/jwks.json
export SCHLUSSEL_INTERNAL_URL=http://localhost:4000
export JWT_ISSUER=schlussel
export ALLOWED_ORIGINS=http://localhost:5177
export KUVERT_ORIGIN=http://localhost:5174
export TAFEL_ORIGIN=http://localhost:5175
export GLOCKE_EVENT_SOURCES=schlussel,kuvert,tafel,zettel
export GLOCKE_SOURCE_KEY_ID_SCHLUSSEL=schlussel-v1
export GLOCKE_SOURCE_SECRET_SCHLUSSEL='<same value as Schlussel SCHLUSSEL_TO_GLOCKE_HMAC_SECRET>'
export GLOCKE_SOURCE_KEY_ID_KUVERT=kuvert-v1
export GLOCKE_SOURCE_SECRET_KUVERT='<same value as Kuvert KUVERT_TO_GLOCKE_HMAC_SECRET>'
export GLOCKE_SOURCE_KEY_ID_TAFEL=tafel-v1
export GLOCKE_SOURCE_SECRET_TAFEL='<same value as Tafel TAFEL_TO_GLOCKE_HMAC_SECRET>'
export GLOCKE_SOURCE_KEY_ID_ZETTEL=zettel-v1
export GLOCKE_SOURCE_SECRET_ZETTEL='<same value as Zettel ZETTEL_TO_GLOCKE_HMAC_SECRET>'
export GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID=glocke-v1
export GLOCKE_TO_SCHLUSSEL_HMAC_SECRET='<same value accepted by Schlussel>'
pnpm dev:backend
```

The Vite frontend defaults to `http://localhost:4001` for Schlüssel,
`http://localhost:3000` for Schloss, and proxies `/backend` to the direct
Glocke backend on port `3004`. Override those browser URLs with
`VITE_SCHLUSSEL_URL` and `VITE_SCHLOSS_URL` in `frontend/.env` if needed.
The Settings page downloads the current user's Glocke snapshot directly as
`glocke-export-YYYY-MM-DD.json` through the existing authenticated API client.

### Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_PATH` | Required SQLite path used by a direct backend run; Compose maps `GLOCKE_DATABASE_PATH` to it |
| `SCHLUSSEL_JWKS_URL` / `JWT_ISSUER` | Schlüssel JWKS endpoint and exact expected JWT issuer |
| `SCHLUSSEL_INTERNAL_URL` | Origin used for signed recipient-preference lookups |
| `ALLOWED_ORIGINS` | Exact direct-run comma-separated CORS origins; Compose maps `GLOCKE_ALLOWED_ORIGINS` to it and defaults to every local Hof frontend: `https://localhost`, `https://auth.localhost`, `https://kuvert.localhost`, `https://tafel.localhost`, `https://zettel.localhost`, and `https://glocke.localhost` |
| `KUVERT_ORIGIN` / `TAFEL_ORIGIN` | Direct-run exact trusted origins used to render absolute source action links; HTTPS is required except for `localhost`, `127.0.0.1`, or `[::1]` development origins |
| `KUVERT_URL` / `TAFEL_URL` | Compose/Tor public service origins mapped to backend `KUVERT_ORIGIN` / `TAFEL_ORIGIN` |
| `GLOCKE_EVENT_SOURCES` | Comma-separated, unique lowercase producer service names |
| `GLOCKE_SOURCE_KEY_ID_<SOURCE>` / `GLOCKE_SOURCE_SECRET_<SOURCE>` | Runtime credential for each source; hyphens in the uppercased source become underscores |
| `GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID` / `GLOCKE_TO_SCHLUSSEL_HMAC_SECRET` | Separate outbound credential for Schlüssel recipient lookups |
| `GLOCKE_MAX_SKEW_SECONDS` / `GLOCKE_MAX_EVENT_BYTES` | Signature timestamp tolerance and signed request-body limit |
| `GLOCKE_WORKER_INTERVAL_MS` / `GLOCKE_WORKER_LEASE_MS` | Inbox polling interval and claim lease |
| `GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS` | Timeout for each current-recipient lookup |
| `GLOCKE_PUBLIC_URL` | Glocke's own public origin; resolves a relative in-app `actionUrl` into an absolute push destination. Defaults to a local-dev origin |
| `GLOCKE_BROWSER_PUSH_ENABLED` | Feature flag; `false` by default and requires no VAPID configuration when off |
| `GLOCKE_VAPID_SUBJECT` / `GLOCKE_VAPID_PUBLIC_KEY` / `GLOCKE_VAPID_PRIVATE_KEY` | Required only when the flag is on; generate once with `npx web-push generate-vapid-keys` and keep stable — rotating requires every browser to re-subscribe |
| `GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS` | Comma-separated provider-host allowlist; an entry starting with `.` matches as a hostname suffix (covers Microsoft WNS's per-region hosts). Required and non-empty when the flag is on |
| `GLOCKE_PUSH_FETCH_TIMEOUT_MS` / `GLOCKE_PUSH_WORKER_LEASE_MS` | Push send timeout and claim lease; the lease must be strictly greater than the timeout. Defaults 10s / 30s |
| `GLOCKE_PUSH_WORKER_INTERVAL_MS` | Push worker polling interval; default 1s |
| `GLOCKE_PUSH_MAX_ATTEMPTS` / `GLOCKE_PUSH_RETRY_BASE_DELAY_MS` / `GLOCKE_PUSH_RETRY_MAX_DELAY_MS` | Retry attempt cap and full-jitter backoff bounds; defaults 8 / 1s / 6h |
| `GLOCKE_PUSH_MAX_SUBSCRIPTIONS_PER_USER` | Active browser cap per account; default 10 |
| `GLOCKE_PUSH_DELIVERY_RETENTION_MS` | Retention for settled Push delivery rows; default 30 days |

Every producer secret must be unique and must also differ from `GLOCKE_TO_SCHLUSSEL_HMAC_SECRET`. `GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS` bounds each preference lookup; `GLOCKE_WORKER_LEASE_MS` must provide at least 10 seconds beyond that timeout for rendering and SQLite contention. Defaults are 5 seconds and 30 seconds respectively.

Generate each HMAC secret independently, for example with
`openssl rand -base64 32`. Put the same directional value at both ends:
Schlüssel's `SCHLUSSEL_TO_GLOCKE_HMAC_SECRET` equals Glocke's
`GLOCKE_SOURCE_SECRET_SCHLUSSEL`, while
`GLOCKE_TO_SCHLUSSEL_HMAC_SECRET` is shared under that name by both services.
Never reuse one direction's value for the other, commit `.env`, or paste
secrets/signatures into issues or logs. Glocke requires every secret to be at
least 32 bytes and rejects duplicate configured secrets at startup.

To add a future producer, first register its event type(s) in
`backend/src/event-registry.ts` (source, payload schema, Russian rendering) — `loadConfig`
rejects any name in `GLOCKE_EVENT_SOURCES` that the registry doesn't recognize.
Then add its lowercase source name to `GLOCKE_EVENT_SOURCES`, configure its
generated `GLOCKE_SOURCE_KEY_ID_<SOURCE>` and `GLOCKE_SOURCE_SECRET_<SOURCE>`
runtime variables (and matching Compose substitutions), then configure the
same key ID and secret in that producer.

## Docker and Tor

For this repo's Compose project, create the shared network once, replace all five
secret placeholders in `.env` with independently generated values, and ensure
the separately deployed producer services use those same directional values:

```sh
docker network create schloss-net
cp .env.example .env
# Run `openssl rand -base64 32` five times and put one result in each HMAC secret.
docker compose up -d --build
```

Compose services are `glocke-backend` and `glocke-frontend`; persistent state uses `glocke-data`. Neither service publishes a host port because `tor` is the platform entry point. Frontend Caddy proxies `/backend/*` to Glocke and `/auth/*` to Schlüssel.

For the complete local platform, run Compose from the sibling `tor/` repo
instead. Its Compose file includes Glocke and routes
`https://glocke.localhost` to `glocke-frontend`. Set
all four producer-to-Glocke secrets and `GLOCKE_TO_SCHLUSSEL_HMAC_SECRET` in
`tor/.env` before startup; the included producer and Glocke Compose files
consume the same directional values.

```sh
cd ../tor
docker network create schloss-net  # one-time; skip if it already exists
cp .env.example .env
# Add five independently generated HMAC secrets to .env, then:
docker compose up -d --build
```

Only Tor publishes ports `80` and `443`. Caddy upgrades the local hosts to
HTTPS with its local CA; follow Tor's README to trust that CA in the browser.

## Operations

- `GET /health` is liveness; `GET /ready` checks SQLite.
- `GET /exports/me` accepts normal access JWTs and delegated export JWTs; delegated tokens are rejected by all ordinary notification APIs.
- `GET /openapi.json` requires an authenticated administrator. The frontend exposes it at admin-only `/docs`.
- Migrations run at startup. Generate schema changes with `pnpm db:generate`.
- The action-link hardening migration clears links stored before the central
  event registry; new links are rendered only from trusted configured origins.
- `SIGINT` and `SIGTERM` stop the HTTP server and new worker claims, wait for the active worker, then close SQLite. A 10-second fail-safe exits nonzero if graceful shutdown does not finish.

## Verification

```sh
pnpm test
pnpm lint
pnpm build
pnpm --filter backend db:generate
docker compose config
git diff --check
```

## Roadmap

The foundation materializes in-app notifications, with the producer outbox
and signed event contract now rolled out to every registered Hof service
(Schlüssel, Kuvert, Tafel, Zettel). The shared Hof `Header` now includes a
Glocke bell with auth-safe unread state. Browser Push is now implemented:
Glocke owns VAPID keys, browser subscriptions, a leased retry worker, and a
push-only service worker; Schlüssel owns only the global on/off switch.
Follow-up work is ordered as follows:

1. Add the Telegram bot and secure account-linking flow.

Telegram bot/linking remains explicitly deferred and is not implemented.
iOS/PWA installation is a separate future phase from this first Browser Push
rollout, which supports desktop and Android.

### Browser Push

Materialization gates each channel independently: an in-app `notifications`
row is created only when `notifyInApp` is true, and one `push_deliveries` row
per currently-active subscription is created only when `notifyBrowserPush` is
true, both inside the same fenced write as the existing inbox claim. A push
subscription registered after an event was already processed never
retroactively receives a delivery for that past event. The wire payload sent
to the browser (`{ id, text, url }`) is always generic - the real per-event
Russian title/body from the event registry is for the in-app row and the
trusted destination page only, never the push notification body itself.

The retry worker (`backend/src/push-worker.ts`) wraps `web-push` behind a
network-free adapter, re-checks the recipient's global preference at send
time (not just at enqueue time), deletes a subscription and settles its
related deliveries on 404/410, retries other retryable outcomes with
full-jitter backoff capped by `GLOCKE_PUSH_RETRY_MAX_DELAY_MS`, and honors
(but caps) delta-seconds and HTTP-date `Retry-After` values. Every claimed row
is fenced on settlement; stale writes and unexpected worker failures are
logged. Startup rejects mismatched VAPID pairs. Initial and periodic
maintenance removes expired subscriptions, subscriptions tagged with an old
VAPID key, orphaned accounts, and terminal deliveries past retention.

`GET/PUT/DELETE /notifications/push/*` enforce owner isolation, a
provider-host allowlist with SSRF/private-range rejection, and a per-user
subscription cap; responses never include a raw endpoint, encryption keys,
or the VAPID private key. New rows require Schlüssel's stable `sid` claim and
store it with the endpoint hash. Status and deletion match the verified user,
session, and current local Push endpoint instead of selecting an arbitrary
account subscription. Migrated legacy rows retain `session_id = NULL` and are
never attributed to a current session; registering that exact local endpoint
claims it for the verified session. Signed Schlüssel cleanup removes only the
revoked session. `/push-cleanup` is an unauthenticated Glocke-origin page for
best-effort local unsubscribe, while durable server cleanup keeps logout
independent of browser or Glocke availability.

The service worker (`frontend/public/sw.js`) has
no fetch handler and never receives a JWT; a push shows only neutral text
and a trusted destination URL. A click navigates an existing same-origin
Glocke tab to that destination before focusing it, or opens a new window.

Disabled by default (`GLOCKE_BROWSER_PUSH_ENABLED=false`) and requires no
VAPID configuration until enabled - see the environment variable table
below.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
