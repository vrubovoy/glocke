import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCorsMiddleware } from '@zudar107/schloss-server-kit'
import { Hono } from 'hono'
import webPush from 'web-push'
import { loadConfig, resolveSecret } from '../config.js'
import type { SecretFileAccess } from '../config.js'

const LOCAL_FRONTEND_ORIGINS = [
  'https://localhost',
  'https://auth.localhost',
  'https://kuvert.localhost',
  'https://tafel.localhost',
  'https://zettel.localhost',
  'https://glocke.localhost',
  'https://schrank.localhost',
  'https://herold.localhost',
]
const TEST_VAPID = webPush.generateVAPIDKeys()

function validEnv(): NodeJS.ProcessEnv {
  return {
    PORT: '3004', DATABASE_PATH: '/tmp/glocke.db', SCHLUSSEL_JWKS_URL: 'http://schlussel/jwks',
    JWT_ISSUER: 'schlussel', SCHLUSSEL_INTERNAL_URL: 'http://schlussel:4000',
    KUVERT_ORIGIN: 'https://kuvert.example.test', TAFEL_ORIGIN: 'https://tafel.example.test',
    GLOCKE_TO_SCHLUSSEL_HMAC_KEY_ID: 'glocke-v1',
    GLOCKE_TO_SCHLUSSEL_HMAC_SECRET: 'glocke-to-schlussel-secret-32-bytes',
    ALLOWED_ORIGINS: 'https://glocke.localhost', GLOCKE_EVENT_SOURCES: 'schlussel,kuvert,tafel,zettel',
    GLOCKE_SOURCE_KEY_ID_SCHLUSSEL: 'schlussel-v1',
    GLOCKE_SOURCE_SECRET_SCHLUSSEL: 'schlussel-to-glocke-secret-32-bytes',
    GLOCKE_SOURCE_KEY_ID_KUVERT: 'kuvert-v1',
    GLOCKE_SOURCE_SECRET_KUVERT: 'kuvert-to-glocke-secret-with-32-bytes',
    GLOCKE_SOURCE_KEY_ID_TAFEL: 'tafel-v1',
    GLOCKE_SOURCE_SECRET_TAFEL: 'tafel-to-glocke-secret-with-32-bytes',
    GLOCKE_SOURCE_KEY_ID_ZETTEL: 'zettel-v1',
    GLOCKE_SOURCE_SECRET_ZETTEL: 'zettel-to-glocke-secret-with-32-bytes',
  }
}

describe('runtime configuration', () => {
  it('loads complete producer and recipient-call credentials', () => {
    expect(loadConfig(validEnv())).toMatchObject({
      port: 3004, schlusselKeyId: 'glocke-v1', recipientFetchTimeoutMs: 5_000,
      workerLeaseMs: 30_000,
      sourceOrigins: {
        kuvert: 'https://kuvert.example.test',
        tafel: 'https://tafel.example.test',
      },
      producers: {
        schlussel: { keyId: 'schlussel-v1' },
        kuvert: { keyId: 'kuvert-v1' },
        tafel: { keyId: 'tafel-v1' },
        zettel: { keyId: 'zettel-v1' },
      },
    })
  })

  it.each([
    ['PORT', 'NaN'],
    ['GLOCKE_MAX_EVENT_BYTES', '-1'],
    ['GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS', '1.5'],
    ['GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS', 'Infinity'],
    ['GLOCKE_WORKER_LEASE_MS', '10000'],
    ['GLOCKE_EVENT_SOURCES', 'Schlussel'],
    ['GLOCKE_SOURCE_KEY_ID_SCHLUSSEL', 'bad key'],
    ['GLOCKE_SOURCE_SECRET_SCHLUSSEL', 'short'],
    ['GLOCKE_TO_SCHLUSSEL_HMAC_SECRET', 'short'],
    ['SCHLUSSEL_INTERNAL_URL', 'not-a-url'],
    ['SCHLUSSEL_INTERNAL_URL', 'http://user:password@schlussel:4000'],
    ['SCHLUSSEL_INTERNAL_URL', 'http://schlussel:4000/api'],
  ])('fails closed for invalid %s', (name, value) => {
    expect(() => loadConfig({ ...validEnv(), [name]: value })).toThrow()
  })

  it.each([
    ['equal to the timeout', '5000', '5000'],
    ['less than ten seconds of headroom', '5000', '14999'],
  ])('rejects a worker lease %s', (_case, timeout, lease) => {
    expect(() => loadConfig({
      ...validEnv(),
      GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS: timeout,
      GLOCKE_WORKER_LEASE_MS: lease,
    })).toThrow(/at least 10000ms longer/)
  })

  it('accepts exactly ten seconds of lease headroom', () => {
    expect(loadConfig({
      ...validEnv(),
      GLOCKE_RECIPIENT_FETCH_TIMEOUT_MS: '5000',
      GLOCKE_WORKER_LEASE_MS: '15000',
    }).workerLeaseMs).toBe(15_000)
  })

  it('rejects reuse of a producer secret for the outbound credential', () => {
    const env = validEnv()
    env['GLOCKE_TO_SCHLUSSEL_HMAC_SECRET'] = env['GLOCKE_SOURCE_SECRET_SCHLUSSEL']
    expect(() => loadConfig(env)).toThrow(/distinct secret/)
  })

  it('rejects secret reuse between producers', () => {
    const env = {
      ...validEnv(),
      GLOCKE_EVENT_SOURCES: 'schlussel,tafel',
      GLOCKE_SOURCE_KEY_ID_TAFEL: 'tafel-v1',
      GLOCKE_SOURCE_SECRET_TAFEL: validEnv()['GLOCKE_SOURCE_SECRET_SCHLUSSEL'],
    }
    expect(() => loadConfig(env)).toThrow(/distinct secret/)
  })

  it('rejects a configured producer absent from the central event registry', () => {
    expect(() => loadConfig({
      ...validEnv(),
      GLOCKE_EVENT_SOURCES: 'schlussel,unknown',
      GLOCKE_SOURCE_KEY_ID_UNKNOWN: 'unknown-v1',
      GLOCKE_SOURCE_SECRET_UNKNOWN: 'unknown-to-glocke-secret-with-32-bytes',
    })).toThrow(/registry|unsupported|unknown/i)
  })

  it.each([
    ['KUVERT_ORIGIN', 'not-a-url'],
    ['KUVERT_ORIGIN', 'http://kuvert.example.test'],
    ['KUVERT_ORIGIN', 'https://user:password@kuvert.example.test'],
    ['TAFEL_ORIGIN', 'http://tafel.example.test'],
    ['TAFEL_ORIGIN', 'https://tafel.example.test/tasks'],
    ['TAFEL_ORIGIN', 'https://tafel.example.test?view=tasks'],
  ])('rejects malformed or non-HTTPS action origin %s=%s', (name, value) => {
    expect(() => loadConfig({ ...validEnv(), [name]: value })).toThrow(/origin|HTTPS/i)
  })

  it('accepts HTTP action origins only for direct localhost development', () => {
    expect(loadConfig({
      ...validEnv(),
      KUVERT_ORIGIN: 'http://localhost:5174',
      TAFEL_ORIGIN: 'http://127.0.0.1:5175',
    }).sourceOrigins).toEqual({
      kuvert: 'http://localhost:5174',
      tafel: 'http://127.0.0.1:5175',
    })
  })

  it('maps Tor public URL variables into backend action origins in Compose', () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')
    expect(compose).toContain('KUVERT_ORIGIN: ${KUVERT_URL:-https://kuvert.localhost}')
    expect(compose).toContain('TAFEL_ORIGIN: ${TAFEL_URL:-https://tafel.localhost}')
  })

  it('configures exact CORS access for every local Hof frontend', async () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')
    const configuredDefault = compose.match(/ALLOWED_ORIGINS: \$\{GLOCKE_ALLOWED_ORIGINS:-([^}]+)}/)?.[1]
    expect(configuredDefault).toBeDefined()

    const config = loadConfig({ ...validEnv(), ALLOWED_ORIGINS: configuredDefault })
    expect(config.allowedOrigins).toEqual(LOCAL_FRONTEND_ORIGINS)

    const app = new Hono()
    app.use('*', createCorsMiddleware({ allowedOrigins: config.allowedOrigins }))
    app.get('/notifications/unread-count', (context) => context.json({ count: 0 }))

    for (const origin of LOCAL_FRONTEND_ORIGINS) {
      const response = await app.request('/notifications/unread-count', { headers: { Origin: origin } })
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect(response.headers.get('Vary')).toContain('Origin')
    }

    const rejected = await app.request('/notifications/unread-count', {
      headers: { Origin: 'https://unknown.localhost' },
    })
    expect(rejected.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('allows Authorization in notification preflight responses and varies by Origin', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware({ allowedOrigins: LOCAL_FRONTEND_ORIGINS }))
    app.get('/notifications/unread-count', (context) => context.json({ count: 0 }))

    const response = await app.request('/notifications/unread-count', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://tafel.localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://tafel.localhost')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect(response.headers.get('Vary')).toContain('Origin')
  })
})

// CONTRACT: loadConfig's RuntimeConfig gains a `push` field:
//
//   push: {
//     enabled: boolean
//     vapid: { subject: string; publicKey: string; privateKey: string } | null   // null when disabled
//     allowedProviderHosts: string[]
//     maxSubscriptionsPerUser: number
//     workerLeaseMs: number
//     fetchTimeoutMs: number
//   }
//
// Env vars, matching Tor's exact list for this feature (.env.example /
// .env.production.example - Tor's own repo, not this one):
//   GLOCKE_BROWSER_PUSH_ENABLED (bool, default false)
//   GLOCKE_VAPID_SUBJECT / GLOCKE_VAPID_PUBLIC_KEY / GLOCKE_VAPID_PRIVATE_KEY (required only when enabled)
//   GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS (comma list, required only when enabled)
// Everything else (worker lease/timeout/backoff/retention knobs) is
// Glocke's own optional, defaulted numeric configuration - the same
// pattern as the existing GLOCKE_WORKER_INTERVAL_MS, not something Tor's
// env files need to enumerate. There is deliberately no separate VAPID
// key-id env var - `vapidKeyId` (used to tag push_subscriptions rows, see
// push-schema.test.ts) is derived deterministically from the public key
// itself, so a future key rotation is just "the public key changed" with
// no extra var to keep in sync.
describe('browser push configuration', () => {
  function pushEnabledEnv(): NodeJS.ProcessEnv {
    return {
      ...validEnv(),
      GLOCKE_BROWSER_PUSH_ENABLED: 'true',
      GLOCKE_VAPID_SUBJECT: 'mailto:push@glocke.example.test',
      GLOCKE_VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
      GLOCKE_VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
      GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS: 'fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com,.notify.windows.com',
    }
  }

  it('is disabled by default and requires no VAPID configuration', () => {
    const config = loadConfig(validEnv())
    expect(config.push).toMatchObject({ enabled: false, vapid: null })
  })

  it('loads a complete enabled configuration', () => {
    const config = loadConfig(pushEnabledEnv())
    expect(config.push).toMatchObject({
      enabled: true,
      vapid: {
        subject: 'mailto:push@glocke.example.test',
        publicKey: TEST_VAPID.publicKey,
        privateKey: TEST_VAPID.privateKey,
      },
    })
    expect(config.push.allowedProviderHosts).toEqual([
      'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '.notify.windows.com',
    ])
  })

  it.each([
    'GLOCKE_VAPID_SUBJECT',
    'GLOCKE_VAPID_PUBLIC_KEY',
    'GLOCKE_VAPID_PRIVATE_KEY',
    'GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS',
  ])('fails closed when enabled but %s is missing', (name) => {
    const env = pushEnabledEnv()
    delete env[name]
    expect(() => loadConfig(env)).toThrow()
  })

  it('rejects an empty allowlist even when otherwise enabled', () => {
    expect(() => loadConfig({ ...pushEnabledEnv(), GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS: '' })).toThrow()
  })

  it('rejects a mismatched VAPID key pair', () => {
    const other = webPush.generateVAPIDKeys()
    expect(() => loadConfig({ ...pushEnabledEnv(), GLOCKE_VAPID_PRIVATE_KEY: other.privateKey })).toThrow(/matching pair/)
  })

  it('requires the push fetch timeout to stay strictly below the push worker lease, mirroring the existing recipient-fetch/worker-lease relationship', () => {
    expect(() => loadConfig({
      ...pushEnabledEnv(),
      GLOCKE_PUSH_FETCH_TIMEOUT_MS: '10000',
      GLOCKE_PUSH_WORKER_LEASE_MS: '10000',
    })).toThrow(/lease/i)
  })

  it('defaults the push worker lease comfortably above the default push fetch timeout', () => {
    const config = loadConfig(pushEnabledEnv())
    expect(config.push.workerLeaseMs).toBeGreaterThan(config.push.fetchTimeoutMs)
  })

  it('does not require push env vars at all when the feature flag is left at its default (false)', () => {
    const env = validEnv()
    for (const name of ['GLOCKE_VAPID_SUBJECT', 'GLOCKE_VAPID_PUBLIC_KEY', 'GLOCKE_VAPID_PRIVATE_KEY', 'GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS']) {
      expect(name in env).toBe(false)
    }
    expect(() => loadConfig(env)).not.toThrow()
  })
})

function files(contents: Buffer | string, options: { regular?: boolean; size?: number; failRead?: boolean } = {}): SecretFileAccess {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  return {
    stat: () => {
      if (options.failRead) throw new Error('injected stat failure')
      return { isFile: () => options.regular ?? true, size: options.size ?? bytes.length }
    },
    read: () => {
      if (options.failRead) throw new Error('injected read failure')
      return bytes
    },
  }
}

describe('resolveSecret', () => {
  it('reads the direct value when only that is set', () => {
    expect(resolveSecret({ TEST_SECRET: 'value' }, 'TEST_SECRET')).toBe('value')
  })

  it('reads a secret file, removes exactly one terminal newline, and preserves other bytes', () => {
    const secret = `${' s'.repeat(16)}\n\n`
    expect(resolveSecret(
      { TEST_SECRET_FILE: '/run/secrets/test' },
      'TEST_SECRET',
      files(secret),
    )).toBe(secret.slice(0, -1))
  })

  it('accepts CRLF and removes it as one terminal line ending', () => {
    expect(resolveSecret(
      { TEST_SECRET_FILE: '/run/secrets/test' },
      'TEST_SECRET',
      files(`${'g'.repeat(32)}\r\n`),
    )).toBe('g'.repeat(32))
  })

  it.each([
    ['both direct and file values', { TEST_SECRET: 'x'.repeat(32), TEST_SECRET_FILE: '/secret' }, files('x'.repeat(32))],
    ['file path whitespace', { TEST_SECRET_FILE: ' /secret' }, files('x'.repeat(32))],
    ['non-regular file', { TEST_SECRET_FILE: '/secret' }, files('x'.repeat(32), { regular: false })],
    ['file over 64 KiB', { TEST_SECRET_FILE: '/secret' }, files('x'.repeat(32), { size: 65_537 })],
    ['read failure', { TEST_SECRET_FILE: '/secret' }, files('x'.repeat(32), { failRead: true })],
    ['invalid UTF-8', { TEST_SECRET_FILE: '/secret' }, files(Buffer.from([0xc3, 0x28]))],
    ['empty after newline removal', { TEST_SECRET_FILE: '/secret' }, files('\n')],
    ['NUL byte', { TEST_SECRET_FILE: '/secret' }, files(`${'x'.repeat(32)}\0`)],
    ['neither value set', {}, files('unused')],
  ])('rejects %s', (_case, env, access) => {
    expect(() => resolveSecret(env, 'TEST_SECRET', access)).toThrow()
  })
})

describe('secret file indirection for loadConfig', () => {
  it('accepts the Glocke-to-Schlussel HMAC secret from a file', () => {
    const env = validEnv()
    delete env['GLOCKE_TO_SCHLUSSEL_HMAC_SECRET']
    env['GLOCKE_TO_SCHLUSSEL_HMAC_SECRET_FILE'] = '/run/secrets/glocke-to-schlussel'
    expect(loadConfig(env, files('glocke-to-schlussel-secret-32-bytes')).schlusselSecret)
      .toBe('glocke-to-schlussel-secret-32-bytes')
  })

  it('accepts a producer secret from a file', () => {
    const env = validEnv()
    delete env['GLOCKE_SOURCE_SECRET_SCHLUSSEL']
    env['GLOCKE_SOURCE_SECRET_SCHLUSSEL_FILE'] = '/run/secrets/schlussel-producer'
    expect(loadConfig(env, files('schlussel-to-glocke-secret-32-bytes')).producers['schlussel']?.secret)
      .toBe('schlussel-to-glocke-secret-32-bytes')
  })

  it('accepts the VAPID private key from a file when push is enabled', () => {
    const vapid = webPush.generateVAPIDKeys()
    const env: NodeJS.ProcessEnv = {
      ...validEnv(),
      GLOCKE_BROWSER_PUSH_ENABLED: 'true',
      GLOCKE_VAPID_SUBJECT: 'mailto:push@glocke.example.test',
      GLOCKE_VAPID_PUBLIC_KEY: vapid.publicKey,
      GLOCKE_VAPID_PRIVATE_KEY_FILE: '/run/secrets/vapid-private',
      GLOCKE_PUSH_ALLOWED_ENDPOINT_HOSTS: 'fcm.googleapis.com',
    }
    expect(loadConfig(env, files(vapid.privateKey)).push.vapid?.privateKey).toBe(vapid.privateKey)
  })

  it('rejects both the direct value and the file being set for the same secret', () => {
    const env = validEnv()
    env['GLOCKE_TO_SCHLUSSEL_HMAC_SECRET_FILE'] = '/run/secrets/glocke-to-schlussel'
    expect(() => loadConfig(env, files('unused'))).toThrow(/mutually exclusive/)
  })
})
