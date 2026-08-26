import { createECDH, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { ProducerCredential } from './app.js'
import { registeredEventSources } from './event-registry.js'

const MAX_SECRET_FILE_BYTES = 64 * 1024

export interface SecretFileAccess {
  stat(path: string): { isFile(): boolean; size: number }
  read(path: string): Buffer
}

const defaultSecretFileAccess: SecretFileAccess = {
  stat: statSync,
  read: readFileSync,
}

// Every secret-shaped env var below (per-producer HMAC secrets, the
// Glocke->Schlussel HMAC secret, the VAPID private key) accepts either
// `NAME` directly or `NAME_FILE` pointing at a file holding it, so a
// deployment can mount a secret file instead of putting the raw value in
// the container's environment. `files` is only overridden in tests.
export function resolveSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  files: SecretFileAccess = defaultSecretFileAccess,
): string {
  const direct = env[name] || undefined
  const fileName = `${name}_FILE`
  const path = env[fileName] || undefined
  if (direct && path) throw new Error(`${name} and ${fileName} are mutually exclusive`)

  let value = direct
  if (path) {
    if (path.trim() !== path) throw new Error(`${fileName} must not have surrounding whitespace`)
    let bytes: Buffer
    try {
      const metadata = files.stat(path)
      if (!metadata.isFile()) throw new Error('not a regular file')
      if (metadata.size > MAX_SECRET_FILE_BYTES) throw new Error('file is too large')
      bytes = files.read(path)
    } catch {
      throw new Error(`${fileName} must reference a readable regular file no larger than 64 KiB`)
    }
    if (bytes.length > MAX_SECRET_FILE_BYTES) {
      throw new Error(`${fileName} must reference a readable regular file no larger than 64 KiB`)
    }
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`${fileName} must contain valid UTF-8`)
    }
    if (value.endsWith('\r\n')) value = value.slice(0, -2)
    else if (value.endsWith('\n')) value = value.slice(0, -1)
    if (!value || value.includes('\0')) throw new Error(`${fileName} must contain a non-empty secret without NUL bytes`)
  }

  if (!value) throw new Error(`${name} or ${fileName} is required`)
  return value
}

export interface RuntimeConfig {
  port: number
  databasePath: string
  jwksUrl: string
  jwtIssuer: string
  schlusselInternalUrl: string
  schlusselKeyId: string
  schlusselSecret: string
  allowedOrigins: string[]
  producers: Record<string, ProducerCredential>
  sourceOrigins: SourceOrigins
  maxSkewSeconds: number
  maxEventBytes: number
  workerIntervalMs: number
  workerLeaseMs: number
  recipientFetchTimeoutMs: number
  glockePublicUrl: string
  push: PushConfig
}

export interface SourceOrigins {
  kuvert: string
  tafel: string
}

export interface PushConfig {
  enabled: boolean
  vapid: { subject: string; publicKey: string; privateKey: string } | null
  allowedProviderHosts: string[]
  fetchTimeoutMs: number
  workerLeaseMs: number
  workerIntervalMs: number
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  maxSubscriptionsPerUser: number
  retentionMs: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value || !value.trim()) throw new Error(`${name} is required`)
  if (value !== value.trim()) throw new Error(`${name} must not have leading or trailing whitespace`)
  return value
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim() || String(fallback)
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function url(value: string, name: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`${name} must be an absolute HTTP(S) URL`) }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(`${name} must be an absolute HTTP(S) URL`)
  }
  return parsed.toString().replace(/\/$/, '')
}

function origin(value: string, name: string): string {
  const parsed = new URL(url(value, name))
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials or a path`)
  }
  return parsed.origin
}

function actionOrigin(value: string, name: string): string {
  const parsed = new URL(origin(value, name))
  const isLocalDevelopment = parsed.protocol === 'http:' && (
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  )
  if (parsed.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error(`${name} must be an HTTPS origin (HTTP is allowed only for localhost development)`)
  }
  return parsed.origin
}

function keyId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function secret(value: string, name: string): string {
  if (Buffer.byteLength(value) < 32) throw new Error(`${name} must be at least 32 bytes`)
  return value
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be "true" or "false"`)
}

function vapidSubject(value: string, name: string): string {
  if (value.startsWith('mailto:') && value.length > 'mailto:'.length) return value
  try {
    if (new URL(value).protocol === 'https:') return value
  } catch { /* fall through to the error below */ }
  throw new Error(`${name} must be a mailto: address or an HTTPS URL`)
}

function loadPushConfig(env: NodeJS.ProcessEnv, files: SecretFileAccess): PushConfig {
  const enabled = boolean(env, 'GLOCKE_BROWSER_PUSH_ENABLED', false)
  const fetchTimeoutMs = integer(env, 'GLOCKE_PUSH_FETCH_TIMEOUT_MS', 10_000, 1, 3_590_000)
  const workerLeaseMs = integer(env, 'GLOCKE_PUSH_WORKER_LEASE_MS', 30_000, 1, 3_600_000)
  if (workerLeaseMs <= fetchTimeoutMs) {
    throw new Error('GLOCKE_PUSH_WORKER_LEASE_MS must be strictly greater than GLOCKE_PUSH_FETCH_TIMEOUT_MS (the delivery lease)')
  }
  const shared = {
    fetchTimeoutMs,
    workerLeaseMs,
    workerIntervalMs: integer(env, 'GLOCKE_PUSH_WORKER_INTERVAL_MS', 1_000, 10, 3_600_000),
    maxAttempts: integer(env, 'GLOCKE_PUSH_MAX_ATTEMPTS', 8, 1, 100),
    baseDelayMs: integer(env, 'GLOCKE_PUSH_RETRY_BASE_DELAY_MS', 1_000, 1, 3_600_000),
    maxDelayMs: integer(env, 'GLOCKE_PUSH_RETRY_MAX_DELAY_MS', 6 * 60 * 60_000, 1_000, 24 * 60 * 60_000),
    maxSubscriptionsPerUser: integer(env, 'GLOCKE_PUSH_MAX_SUBSCRIPTIONS_PER_USER', 10, 1, 100),
    retentionMs: integer(env, 'GLOCKE_PUSH_DELIVERY_RETENTION_MS', 30 * 24 * 60 * 60_000, 60_000, 365 * 24 * 60 * 60_000),
  }
  if (!enabled) return { enabled: false, vapid: null, allowedProviderHosts: [], ...shared }

  const subject = vapidSubject(required(env, 'GLOCKE_VAPID_SUBJECT'), 'GLOCKE_VAPID_SUBJECT')
  const publicKey = required(env, 'GLOCKE_VAPID_PUBLIC_KEY')
  const privateKey = resolveSecret(env, 'GLOCKE_VAPID_PRIVATE_KEY', files)
  let derivedPublicKey: Buffer
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'))
    derivedPublicKey = ecdh.getPublicKey()
  } catch {
    throw new Error('GLOCKE_VAPID_PRIVATE_KEY must be valid P-256 key material')
  }
  const configuredPublicKey = Buffer.from(publicKey, 'base64url')
  if (configuredPublicKey.length !== derivedPublicKey.length || !timingSafeEqual(configuredPublicKey, derivedPublicKey)) {
    throw new Error('GLOCKE_VAPID_PUBLIC_KEY and GLOCKE_VAPID_PRIVATE_KEY must be a matching pair')
  }
  const allowedProviderHosts = required(env, 'GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS').split(',').map((value) => value.trim()).filter(Boolean)
  if (allowedProviderHosts.length === 0) throw new Error('GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS must list at least one provider host')

  return { enabled: true, vapid: { subject, publicKey, privateKey }, allowedProviderHosts, ...shared }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  files: SecretFileAccess = defaultSecretFileAccess,
): RuntimeConfig {
  const sources = required(env, 'GLOCKE_EVENT_SOURCES').split(',').map((value) => value.trim())
  if (sources.some((source) => !/^[a-z][a-z0-9-]{0,63}$/.test(source)) || new Set(sources).size !== sources.length) {
    throw new Error('GLOCKE_EVENT_SOURCES must contain unique lowercase service names')
  }
  const unregistered = sources.filter((source) => !registeredEventSources.has(source))
  if (unregistered.length > 0) {
    throw new Error(`GLOCKE_EVENT_SOURCES contains a producer absent from the central event registry: ${unregistered.join(', ')}`)
  }
  const producers = Object.fromEntries(sources.map((source) => {
    const suffix = source.toUpperCase().replaceAll('-', '_')
    return [source, {
      keyId: keyId(required(env, `GLOCKE_SOURCE_KEY_ID_${suffix}`), `GLOCKE_SOURCE_KEY_ID_${suffix}`),
      secret: secret(resolveSecret(env, `GLOCKE_SOURCE_SECRET_${suffix}`, files), `GLOCKE_SOURCE_SECRET_${suffix}`),
    }]
  }))
  const origins = required(env, 'ALLOWED_ORIGINS').split(',').map((value) => origin(value.trim(), 'ALLOWED_ORIGINS'))
  const schlusselSecret = secret(resolveSecret(env, 'GLOCKE_TO_SCHLUSSEL_HMAC_SECRET', files), 'GLOCKE_TO_SCHLUSSEL_HMAC_SECRET')
  const configuredSecrets = [schlusselSecret, ...Object.values(producers).map((credential) => credential.secret)]
  if (new Set(configuredSecrets).size !== configuredSecrets.length) {
    throw new Error('Every producer and Glocke-to-Schlussel HMAC credential must use a distinct secret')
  }
  const recipientFetchTimeoutMs = integer(
    env, 'GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS', 5_000, 1, 3_590_000,
  )
  const workerLeaseMs = integer(env, 'GLOCKE_WORKER_LEASE_MS', 30_000, 1, 3_600_000)
  if (workerLeaseMs - recipientFetchTimeoutMs < 10_000) {
    throw new Error('GLOCKE_WORKER_LEASE_MS must be at least 10000ms longer than GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS')
  }

  return {
    port: integer(env, 'PORT', 3004, 1, 65_535),
    databasePath: required(env, 'DATABASE_PATH'),
    jwksUrl: url(required(env, 'SCHLUSSEL_JWKS_URL'), 'SCHLUSSEL_JWKS_URL'),
    jwtIssuer: required(env, 'JWT_ISSUER'),
    schlusselInternalUrl: origin(required(env, 'SCHLUSSEL_INTERNAL_URL'), 'SCHLUSSEL_INTERNAL_URL'),
    schlusselKeyId: keyId(required(env, 'GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID'), 'GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID'),
    schlusselSecret,
    allowedOrigins: origins,
    producers,
    sourceOrigins: {
      kuvert: actionOrigin(required(env, 'KUVERT_ORIGIN'), 'KUVERT_ORIGIN'),
      tafel: actionOrigin(required(env, 'TAFEL_ORIGIN'), 'TAFEL_ORIGIN'),
    },
    maxSkewSeconds: integer(env, 'GLOCKE_MAX_SKEW_SECONDS', 300, 0, 86_400),
    maxEventBytes: integer(env, 'GLOCKE_MAX_EVENT_BYTES', 65_536, 1, 1_048_576),
    workerIntervalMs: integer(env, 'GLOCKE_WORKER_INTERVAL_MS', 1_000, 10, 3_600_000),
    workerLeaseMs,
    recipientFetchTimeoutMs,
    // Glocke's own public origin - only needed to turn a relative in-app
    // actionUrl (e.g. Schlüssel's '/settings') into an absolute push
    // destination URL a service worker can open from outside page context.
    // Falls back to a harmless local-dev default rather than being
    // required, since only Browser Push actually depends on it.
    glockePublicUrl: origin(env['GLOCKE_PUBLIC_URL']?.trim() || 'http://localhost:5177', 'GLOCKE_PUBLIC_URL'),
    push: loadPushConfig(env, files),
  }
}
