import { describe, expect, it } from 'vitest'
import { parseWebPushRetryAfter } from '../web-push-adapter.js'

describe('web push Retry-After parsing', () => {
  it('accepts delta-seconds and IMF-fixdate values', () => {
    const now = Date.parse('2026-08-07T10:00:00.000Z')
    expect(parseWebPushRetryAfter('5', () => now)).toBe(5_000)
    expect(parseWebPushRetryAfter('Fri, 07 Aug 2026 10:00:05 GMT', () => now)).toBe(5_000)
  })

  it('rejects malformed values', () => {
    expect(parseWebPushRetryAfter('next Tuesday')).toBeUndefined()
  })
})
