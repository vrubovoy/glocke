import { describe, expect, it } from 'vitest'
import { validatePushSubscriptionInput } from '../push-validation.js'

// CONTRACT: backend/src/push-validation.ts exports
//   validatePushSubscriptionInput(body: unknown, allowedProviderHosts: readonly string[])
//     => { valid: true; endpoint: string; p256dh: string; auth: string; expirationTime: number | null; providerHost: string }
//      | { valid: false; reason: 'malformed-body' | 'insecure-endpoint' | 'endpoint-too-long' | 'key-too-long' | 'provider-not-allowed' }
//
// `body` is the raw `PushSubscription.toJSON()` shape PUT by the
// frontend: `{ endpoint, keys: { p256dh, auth }, expirationTime? }`.
// An allowlist entry starting with '.' matches as a hostname SUFFIX
// (covers Microsoft WNS's per-region `wns2-xx.notify.windows.com` hosts);
// every other entry is an exact hostname match. This is the server-side
// adaptation of schloss-ui's `useUnreadNotifications.ts` `isNonPublicHost`
// SSRF guard (loopback/link-local/private-range/internal-TLD rejection),
// applied here as an allowlist (only known push-vendor hosts) rather than
// a denylist, since the set of legitimate push endpoints is small and
// fixed. Byte limits below (2048 for endpoint, 256 for each key) are this
// suite's chosen contract values - the implementer may pick different
// numbers as long as they are finite, documented, and something is
// rejected past them.

const ALLOWLIST = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '.notify.windows.com']

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { keys, ...rest } = overrides as { keys?: Record<string, unknown> }
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22), ...keys },
    ...rest,
  }
}

describe('push subscription input validation', () => {
  it('accepts a well-formed Google (FCM) subscription and reports its provider host', () => {
    const result = validatePushSubscriptionInput(validBody(), ALLOWLIST)
    expect(result).toMatchObject({ valid: true, providerHost: 'fcm.googleapis.com', endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' })
  })

  it('accepts an optional expirationTime and defaults it to null when absent', () => {
    expect(validatePushSubscriptionInput(validBody({ expirationTime: 1_800_000_000_000 }), ALLOWLIST))
      .toMatchObject({ valid: true, expirationTime: 1_800_000_000_000 })
    expect(validatePushSubscriptionInput(validBody(), ALLOWLIST)).toMatchObject({ valid: true, expirationTime: null })
  })

  // Firefox's PushSubscription.toJSON() includes expirationTime explicitly
  // as `null` when there's no expiration, rather than omitting the key -
  // both must be accepted identically.
  it('accepts an explicit null expirationTime the same as an absent one', () => {
    expect(validatePushSubscriptionInput(validBody({ expirationTime: null }), ALLOWLIST))
      .toMatchObject({ valid: true, expirationTime: null })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 1_700_000_000_000])(
    'rejects an invalid or expired expirationTime: %s',
    (expirationTime) => {
      expect(validatePushSubscriptionInput(
        validBody({ expirationTime }), ALLOWLIST, new Date('2026-08-07T10:00:00.000Z'),
      )).toMatchObject({ valid: false, reason: 'invalid-expiration' })
    },
  )

  it.each([
    ['Mozilla', 'https://updates.push.services.mozilla.com/wpush/v2/xyz', 'updates.push.services.mozilla.com'],
    ['Apple', 'https://web.push.apple.com/QA1b2C3', 'web.push.apple.com'],
  ])('accepts %s endpoints', (_vendor, endpoint, providerHost) => {
    expect(validatePushSubscriptionInput(validBody({ endpoint }), ALLOWLIST)).toMatchObject({ valid: true, providerHost })
  })

  it('accepts a suffix-wildcard allowlist entry for Microsoft WNS regional hosts', () => {
    expect(validatePushSubscriptionInput(
      validBody({ endpoint: 'https://wns2-abc123.notify.windows.com/w/?token=xyz' }), ALLOWLIST,
    )).toMatchObject({ valid: true, providerHost: 'wns2-abc123.notify.windows.com' })
  })

  it('rejects a provider host absent from the allowlist', () => {
    expect(validatePushSubscriptionInput(validBody({ endpoint: 'https://push.attacker.invalid/x' }), ALLOWLIST))
      .toMatchObject({ valid: false, reason: 'provider-not-allowed' })
  })

  it.each([
    ['http (not https)', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['embedded credentials', 'https://attacker:secret@fcm.googleapis.com/fcm/send/abc'],
    ['malformed URL', 'not-a-url'],
    ['empty string', ''],
    ['relative path only', '/fcm/send/abc'],
  ])('rejects an endpoint that is %s', (_case, endpoint) => {
    expect(validatePushSubscriptionInput(validBody({ endpoint }), ALLOWLIST).valid).toBe(false)
  })

  it.each([
    ['loopback IPv4', 'https://127.0.0.1/push'],
    ['loopback IPv6', 'https://[::1]/push'],
    ['link-local', 'https://169.254.169.254/latest/meta-data'],
    ['private class A', 'https://10.0.0.5/push'],
    ['private class B', 'https://172.16.0.5/push'],
    ['private class C', 'https://192.168.1.5/push'],
    ['internal TLD .internal', 'https://push.corp.internal/push'],
    ['internal TLD .local', 'https://push.local/push'],
    ['bare hostname with no dot', 'https://push/abc'],
  ])('rejects an SSRF-shaped endpoint host: %s', (_case, endpoint) => {
    // These hosts are also absent from ALLOWLIST, so an allowlist-only
    // implementation already rejects them - this just pins that no SSRF
    // target can slip through even if it happened to share a name with an
    // allowed suffix (e.g. "fcm.googleapis.com.internal" style tricks).
    expect(validatePushSubscriptionInput(validBody({ endpoint }), ALLOWLIST).valid).toBe(false)
  })

  it('rejects a host that merely embeds an allowed provider name inside a disallowed suffix', () => {
    expect(validatePushSubscriptionInput(
      validBody({ endpoint: 'https://fcm.googleapis.com.attacker.invalid/x' }), ALLOWLIST,
    )).toMatchObject({ valid: false, reason: 'provider-not-allowed' })
  })

  it('rejects an endpoint over the configured byte length limit', () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${'a'.repeat(3_000)}`
    expect(validatePushSubscriptionInput(validBody({ endpoint }), ALLOWLIST))
      .toMatchObject({ valid: false, reason: 'endpoint-too-long' })
  })

  it.each(['p256dh', 'auth'])('rejects a %s key over the configured byte length limit', (key) => {
    const result = validatePushSubscriptionInput(
      validBody({ keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22), [key]: 'x'.repeat(5_000) } }), ALLOWLIST,
    )
    expect(result).toMatchObject({ valid: false, reason: 'key-too-long' })
  })

  it.each([
    ['missing endpoint', { keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }],
    ['missing keys', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }],
    ['missing p256dh', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { auth: 'A'.repeat(22) } }],
    ['missing auth', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87) } }],
    ['non-string endpoint', { endpoint: 12_345, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }],
    ['null body', null],
    ['array body', []],
    ['string body', 'not-an-object'],
  ])('rejects a malformed body: %s', (_case, body) => {
    expect(validatePushSubscriptionInput(body, ALLOWLIST)).toMatchObject({ valid: false, reason: 'malformed-body' })
  })

  it('rejects unknown top-level fields (strict body, mirrors the event envelope contract)', () => {
    expect(validatePushSubscriptionInput(validBody({ unexpectedField: 'attacker-controlled' }), ALLOWLIST).valid).toBe(false)
  })

  it('never echoes an invalid endpoint back verbatim for a reason that could leak it into logs unexpectedly', () => {
    // Weak guard against accidentally wiring the rejection reason itself
    // into a log line that reconstructs the raw endpoint - the contract
    // only promises a short enum `reason`, never the input echoed back.
    const result = validatePushSubscriptionInput(validBody({ endpoint: 'https://push.attacker.invalid/secret-path-component' }), ALLOWLIST)
    expect(result).not.toHaveProperty('endpoint')
  })
})
