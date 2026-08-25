# Changelog

## [Unreleased]

### Added

- Hardened Browser Push with endpoint-hash/current-session correlation,
  durable signed session cleanup, explicit legacy-row migration behavior,
  expiration and VAPID rotation cleanup, strict expiration validation,
  VAPID pair startup checks, HTTP-date `Retry-After`, stale lease/error
  logging, settled-delivery retention, local logout cleanup, navigate-then-
  focus notification clicks, and complete Push OpenAPI coverage.

- Browser Push delivery: `push_subscriptions`/`push_deliveries` tables,
  materialization gated independently per channel alongside the existing
  in-app notification write, a leased retry worker around `web-push` with
  full-jitter backoff and 404/410 subscription cleanup, authenticated
  `GET/PUT/DELETE /notifications/push/*` with owner isolation and a
  provider-host allowlist, VAPID runtime configuration, and a push-only
  service worker (`frontend/public/sw.js`) with generic notification
  content and trusted-destination click handling. Disabled by default.
- Standalone durable in-app notification service and Russian notification center.
- Exact-body HMAC-SHA-256 ingestion for the shared v1 event envelope, with
  source/key/timestamp validation, bounded bodies, a durable idempotent inbox,
  conflict detection, and fenced worker leases.
- At-most-one stored notification per source event and recipient, current
  Schlüssel `notifyInApp` lookup before materialization, and durable suppression
  for disabled or deleted recipients. This is retry-safe, not an exactly-once
  delivery claim.
- JWT-isolated list, unread-count, read, read-all, and delete APIs; admin-only
  OpenAPI/Swagger UI; health/readiness endpoints; migrations; graceful worker
  shutdown; containers; CI; and GHCR publishing configuration.
- Documentation for directional secret generation, direct development, Tor,
  producer outbox/inbox guarantees, and the complete Hof ecosystem.
- Direct and delegated account-scoped JSON exports of all user-visible
  notifications and read state, with a shared Settings download action. This
  remains a synchronous Glocke-only endpoint; asynchronous all-services ZIP
  orchestration and artifact retention are owned by Schlüssel.
- Registered notification intake from Schlüssel, Kuvert, Tafel, and Zettel,
  with strict payload validation and centrally rendered source actions.
- Hardened producer credential lookup, persisted-envelope suppression, trimmed
  payload text, and trusted absolute Kuvert/Tafel action origins.
- Cleared pre-registry stored action links on migration, made corrupt inbox JSON
  suppressible, fenced completion after recipient I/O, and reused Tor's public
  Kuvert/Tafel URL variables in Compose.
- Rejected unknown top-level event fields and refreshed lease fencing after
  notification materialization before inbox completion.
- Added the shared Hof Header bell with same-origin unread polling and
  mutation-driven invalidation after successful read, read-all, and delete.
- Marked every notification API response private, no-store, no-cache, and
  nosniff at the outermost HTTP layer, including preflight and early errors,
  and allowed exact CORS access from every local Hof frontend origin.

### Planned

- Add the Telegram bot and secure account-linking flow.
