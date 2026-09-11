# Security Policy

## Supported versions

Glocke is deployed continuously from `main`; no release branches are maintained.

## Reporting

Do not open a public issue for vulnerabilities. Use GitHub's private **Report a vulnerability** flow under this repository's Security tab. An initial response is best-effort, normally within a few days.

## Image publish integrity

`.github/workflows/test.yml`'s `publish` job pushes signed, attested
container images to `ghcr.io/vrubovoy/glocke-backend` and
`ghcr.io/vrubovoy/glocke-frontend`. Its integrity depends on repository
settings kept outside this file:

- **Require actions pinned to a full-length commit SHA**
  (`actions/permissions` → `sha_pinning_required: true`). Every `uses:`
  here is already SHA-pinned.
- **Environment `publish`** with a deployment branch policy allowing only
  the `main` branch and the `v*` tag pattern.
- **Two tag rulesets on `refs/tags/v*`**: one blocking `deletion` /
  `non_fast_forward` / `update` for everyone; one restricting `creation`
  to a repository admin (CI never creates a `v*` tag — a human cuts the
  release).

**Threat model (Model 1).** Every same-repo actor with write access is
trusted; today the only one is a repository admin. A feature branch
controls its own copy of `test.yml` and could drop `environment:` and
request `packages: write`, so the Environment policy gates an *unmodified*
workflow, not a hostile write-collaborator. It still cannot create a `v*`
tag (ruleset) or forge the `@refs/tags/vX.Y.Z` Sigstore identity a
consumer (`hof-ops`'s release lock) checks.

## Scope

Highest-priority reports include cross-account notification access, signature bypass or replay acceptance outside the configured skew, payload identity confusion, leaked producer credentials, unsafe action links, and auth handoff issues. Reports concerning availability or durable inbox loss are also in scope.

## Security model

- Public notification ownership comes only from the subject of a verified
  Schlüssel JWT. Request parameters never select another user.
- Internal event requests authenticate the exact bytes, method, path, source,
  key ID, and timestamp with HMAC-SHA-256. This provides integrity and
  authentication, not confidentiality; use TLS across untrusted networks.
- A valid request can be replayed inside the timestamp window. Stable event
  IDs plus the durable `(source, event_id)` inbox key make an exact replay
  idempotent; a different body for that identity is rejected.
- Producer credentials are directional. Every producer secret must be unique,
  and all must differ from Glocke's outbound recipient-lookup secret. Startup
  rejects secrets shorter than 32 bytes or duplicate configured values.
- Delivery is retry-based and deliberately does not claim exactly-once
  semantics. A producer may resend after an ambiguous response, while Glocke's
  inbox and notification unique keys prevent duplicate stored materialization.
  Materialization and completion use separate fresh lease-fencing timestamps.
- Presentation is never accepted from producers. Glocke validates persisted
  envelopes again before processing, suppresses malformed rows, renders source
  links from trusted origins, and clears pre-registry stored action links during
  migration.

Generate secrets with a cryptographically secure tool such as
`openssl rand -base64 32`. Do not send tokens, raw HMAC secrets, signatures, or
personal notification content in an issue. If a credential may be exposed,
replace the matching value at both ends and change its key ID; Glocke currently
accepts one active key ID per configured producer, so coordinate deployment
rather than assuming an overlapping-key rotation window.
