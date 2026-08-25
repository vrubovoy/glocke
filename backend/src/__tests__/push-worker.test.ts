import { calculateBackoffDelay, classifyNotificationResponse } from '@zudar107/schloss-server-kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPushWorker, type PushAdapter } from '../push-worker.js'
import { pushDeliveryRecord, pushSubscriptionRecord, VAPID } from './helpers/push-fixtures.js'
import { MemoryPushRepository } from './helpers/push-repository.js'

// CONTRACT: backend/src/push-worker.ts exports
//   createPushWorker(options): { deliverOne(), start(), stop(), reconcile(existingUserIds) }
//
// options = {
//   repository: PushRepository            // backend/src/push-repository.ts
//   resolveRecipient: ResolveRecipient    // contracts.ts, re-checked at SEND time, not enqueue time
//   adapter: PushAdapter                  // the ONLY seam that ever touches the network
//   vapid: { publicKey, privateKey, subject }
//   now?, createLeaseId?, random?
//   leaseMs?, fetchTimeoutMs?, maxAttempts?, baseDelayMs?, maxDelayMs?
// }
//
// PushAdapter is a thin wrapper around the `web-push` package - it owns
// ALL network/timeout mechanics itself and resolves with a structured
// outcome instead of throwing, so the worker never needs to manage an
// AbortController and this suite never needs fake timers:
//
//   interface PushAdapter {
//     send(args: {
//       subscription: { endpoint: string; p256dh: string; auth: string }
//       payload: { id: string; text: string; url: string }   // generic content only - never event title/body
//       vapid: { publicKey: string; privateKey: string; subject: string }
//       timeoutMs: number
//     }): Promise<
//       | { outcome: 'sent'; status: number; retryAfterMs?: number }
//       | { outcome: 'timeout' }
//       | { outcome: 'network-error'; message: string }
//     >
//   }
//
// Classification of a `sent` outcome: 404/410 are handled BEFORE generic
// classification (the subscription itself is gone - delete it via
// repository.deleteSubscription(delivery.userId, delivery.subscriptionId),
// which cascades every related pending/processing delivery to 'permanent'
// the same way the owner-initiated DELETE route does). Everything else
// goes through @zudar107/schloss-server-kit's classifyNotificationResponse:
// 2xx -> delivered, retryable (408/425/429/5xx) -> retry with backoff,
// any other 4xx -> permanent. A `timeout` outcome is treated the same as
// a retryable status (ambiguous, not a confirmed failure). A
// `network-error` outcome retries too, with a sanitized `lastError` (the
// adapter's raw `message` must never be persisted verbatim - mirrors how
// notification-runtime.ts never logs a raw response body).
//
// Backoff uses calculateBackoffDelay({ attempt: row.attempts, baseDelayMs,
// maxDelayMs, random }) from the same shared package Kuvert/Tafel/Zettel's
// outbox already depends on for their own retry math - reusing rather
// than reinventing it. `Retry-After` (surfaced by the adapter as
// `retryAfterMs`) is honored directly when present, but always capped at
// `maxDelayMs`.

const NOW = '2026-08-07T10:00:00.000Z'
const VAPID_CONFIG = { publicKey: VAPID.publicKey, privateKey: VAPID.privateKey, subject: VAPID.subject }
const DEFAULT_OPTIONS = {
  now: () => new Date(NOW),
  createLeaseId: () => 'push-lease-1',
  random: () => 0.5,
  leaseMs: 30_000,
  fetchTimeoutMs: 10_000,
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 6 * 60 * 60_000,
}

describe('push delivery worker', () => {
  let repository: MemoryPushRepository
  let adapter: { send: ReturnType<typeof vi.fn<PushAdapter['send']>> }

  beforeEach(() => {
    repository = new MemoryPushRepository()
    adapter = { send: vi.fn() }
  })

  function worker(
    overrides: Record<string, unknown> = {},
    recipient: { notifyInApp?: boolean; notifyBrowserPush: boolean } | null = { notifyBrowserPush: true },
  ) {
    return createPushWorker({
      repository,
      adapter,
      vapid: VAPID_CONFIG,
      resolveRecipient: async (userId: string) => recipient
        ? { userId, notifyInApp: recipient.notifyInApp ?? false, notifyBrowserPush: recipient.notifyBrowserPush }
        : null,
      ...DEFAULT_OPTIONS,
      ...overrides,
    })
  }

  it('is idle with nothing claimable', async () => {
    expect(await worker().deliverOne()).toBe('idle')
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it('sends only generic content - never the event title/body - and marks delivered on 2xx', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', destinationUrl: 'https://glocke.example.test/tasks' }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status: 201 })

    expect(await worker().deliverOne()).toBe('delivered')

    expect(adapter.send).toHaveBeenCalledTimes(1)
    const call = adapter.send.mock.calls[0]![0]
    expect(call.payload).toEqual({ id: 'delivery-1', text: expect.any(String), url: 'https://glocke.example.test/tasks' })
    expect(call.payload.text).not.toMatch(/goal|task|due|title|цель|задача|срок/i)
    expect(call.subscription).toEqual({ endpoint: expect.any(String), p256dh: expect.any(String), auth: expect.any(String) })
    expect(call.vapid).toEqual(VAPID_CONFIG)
    expect(call.timeoutMs).toBe(10_000)

    expect(repository.deliveries[0]).toMatchObject({ state: 'delivered', deliveredAt: NOW })
    expect(repository.subscriptions[0]?.lastSuccessAt).toBe(NOW)
  })

  it('is idle again once the only claimable delivery has been settled', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status: 200 })
    const instance = worker()

    expect(await instance.deliverOne()).toBe('delivered')
    expect(await instance.deliverOne()).toBe('idle')
    expect(adapter.send).toHaveBeenCalledTimes(1)
  })

  it('re-checks the global preference at send time and suppresses instead of sending when it was disabled after enqueue', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))

    expect(await worker({}, { notifyBrowserPush: false }).deliverOne()).toBe('suppressed')

    expect(adapter.send).not.toHaveBeenCalled()
    expect(repository.deliveries[0]).toMatchObject({ state: 'suppressed', leaseId: null })
  })

  it('suppresses without sending when the recipient no longer exists', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))

    expect(await worker({}, null).deliverOne()).toBe('suppressed')
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it('suppresses without sending when the specific subscription was deleted between enqueue and claim', async () => {
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'missing-sub', userId: 'user-1' }))

    expect(await worker().deliverOne()).toBe('suppressed')
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it('deletes the subscription and settles every related pending/processing delivery on 404', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({
      id: 'delivery-2', subscriptionId: 'sub-1', userId: 'user-1', eventId: 'other-event',
      state: 'processing', leaseId: 'someone-elses-lease', leaseUntil: '2026-08-07T10:05:00.000Z',
    }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status: 404 })

    expect(await worker().deliverOne()).toBe('permanent')

    expect(repository.subscriptions).toHaveLength(0)
    expect(repository.deliveries.every((delivery) => delivery.state === 'permanent')).toBe(true)
  })

  it('deletes the subscription on 410 the same way as 404', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status: 410 })

    expect(await worker().deliverOne()).toBe('permanent')
    expect(repository.subscriptions).toHaveLength(0)
  })

  it.each([
    ['expired', { expirationTime: '2026-08-07T09:59:59.000Z' }, VAPID.keyId],
    ['rotated VAPID key', { vapidKeyId: 'old-key' }, VAPID.keyId],
  ])('removes an %s subscription before network delivery', async (_case, overrides, vapidKeyId) => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1', ...overrides }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))

    expect(await worker({ vapidKeyId }).deliverOne()).toBe('permanent')
    expect(adapter.send).not.toHaveBeenCalled()
    expect(repository.subscriptions).toHaveLength(0)
  })

  it.each([400, 401, 403, 413])('treats any other 4xx (%i) as a permanent failure without retrying, leaving the subscription intact', async (status) => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status })

    expect(await worker().deliverOne()).toBe('permanent')

    expect(repository.subscriptions).toHaveLength(1)
    expect(repository.deliveries[0]).toMatchObject({ state: 'permanent', lastStatus: status })
  })

  it.each([408, 425, 429, 500, 503])('retries with full-jitter backoff after a retryable status %i', async (status) => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', attempts: 0 }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status })

    expect(await worker().deliverOne()).toBe('retry')

    expect(classifyNotificationResponse(status)).toBe('retryable')
    const expectedDelay = calculateBackoffDelay({ attempt: 0, baseDelayMs: 1_000, maxDelayMs: 6 * 60 * 60_000, random: () => 0.5 })
    expect(repository.deliveries[0]).toMatchObject({
      state: 'pending', attempts: 1, lastStatus: status,
      nextAttemptAt: new Date(Date.parse(NOW) + expectedDelay).toISOString(),
    })
  })

  it('treats a timeout as a retryable ambiguous outcome, not a permanent failure', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', attempts: 0 }))
    adapter.send.mockResolvedValue({ outcome: 'timeout' })

    expect(await worker().deliverOne()).toBe('retry')

    expect(repository.deliveries[0]).toMatchObject({ state: 'pending', attempts: 1 })
    expect(repository.subscriptions).toHaveLength(1)
  })

  it('retries a network error with backoff and a sanitized error, never the adapter raw error detail', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', attempts: 0 }))
    adapter.send.mockResolvedValue({ outcome: 'network-error', message: 'ECONNRESET at 10.0.4.19:443 secret-looking-detail' })

    expect(await worker().deliverOne()).toBe('retry')

    expect(repository.deliveries[0]?.lastError).not.toContain('secret-looking-detail')
    expect(repository.deliveries[0]?.lastError).not.toContain('10.0.4.19')
  })

  it('honors Retry-After but caps it at the configured maximum backoff', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', attempts: 0 }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status: 503, retryAfterMs: 999 * 60 * 60_000 })

    expect(await worker({ maxDelayMs: 6 * 60 * 60_000 }).deliverOne()).toBe('retry')

    const record = repository.deliveries[0]!
    const delayMs = Date.parse(record.nextAttemptAt!) - Date.parse(NOW)
    expect(delayMs).toBeLessThanOrEqual(6 * 60 * 60_000)
  })

  it('honors a short Retry-After directly', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', attempts: 0 }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status: 429, retryAfterMs: 5_000 })

    expect(await worker().deliverOne()).toBe('retry')

    expect(repository.deliveries[0]?.nextAttemptAt).toBe(new Date(Date.parse(NOW) + 5_000).toISOString())
  })

  it('goes permanent once max attempts are exhausted instead of retrying again', async () => {
    repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', attempts: 7 }))
    adapter.send.mockResolvedValue({ outcome: 'sent', status: 500 })

    expect(await worker({ maxAttempts: 8 }).deliverOne()).toBe('permanent')

    expect(repository.deliveries[0]).toMatchObject({ state: 'permanent', attempts: 8 })
  })

  describe('lease fencing', () => {
    it('claims exactly one due delivery per call and honors a lease already held by another worker', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
      repository.seedDelivery(pushDeliveryRecord({
        id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1',
        state: 'processing', leaseId: 'other-worker-lease', leaseUntil: '2026-08-07T10:05:00.000Z',
      }))

      expect(await worker().deliverOne()).toBe('idle')

      expect(adapter.send).not.toHaveBeenCalled()
      expect(repository.deliveries[0]).toMatchObject({ state: 'processing', leaseId: 'other-worker-lease' })
    })

    it('reclaims a delivery whose lease already expired and settles it under a freshly assigned lease', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
      repository.seedDelivery(pushDeliveryRecord({
        id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1',
        state: 'processing', leaseId: 'crashed-worker-lease', leaseUntil: '2026-08-07T09:59:00.000Z',
      }))
      adapter.send.mockResolvedValue({ outcome: 'sent', status: 200 })

      expect(await worker().deliverOne()).toBe('delivered')

      expect(repository.deliveries[0]).toMatchObject({ state: 'delivered', leaseId: null })
    })

    it('never settles a delivery under a lease id other than the one it just claimed', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
      repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))
      adapter.send.mockResolvedValue({ outcome: 'sent', status: 200 })
      const markDeliveredSpy = vi.spyOn(repository, 'markDelivered')

      await worker({ createLeaseId: () => 'this-calls-own-lease' }).deliverOne()

      expect(markDeliveredSpy).toHaveBeenCalledWith('delivery-1', 'this-calls-own-lease', NOW)
    })

    it('logs a stale settlement instead of silently reporting success', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
      repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))
      adapter.send.mockResolvedValue({ outcome: 'sent', status: 200 })
      vi.spyOn(repository, 'markDelivered').mockResolvedValue(false)
      const logger = { error: vi.fn(), warn: vi.fn() }

      await worker({ logger }).deliverOne()

      expect(logger.warn).toHaveBeenCalledWith(
        '[Glocke push worker] Stale delivered settlement',
        { deliveryId: 'delivery-1', leaseId: 'push-lease-1' },
      )
    })

    it('does not reclaim a pending delivery before its scheduled retry time', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
      repository.seedDelivery(pushDeliveryRecord({
        id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1',
        state: 'pending', nextAttemptAt: '2026-08-07T10:05:00.000Z',
      }))

      expect(await worker().deliverOne()).toBe('idle')
      expect(adapter.send).not.toHaveBeenCalled()
    })
  })

  describe('reconciliation sweep', () => {
    it('deletes subscriptions belonging to accounts that no longer exist', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-existing', userId: 'user-1' }))
      repository.seedSubscription(pushSubscriptionRecord({
        id: 'sub-orphaned', userId: 'deleted-user', endpoint: 'https://fcm.googleapis.com/fcm/send/orphan',
      }))

      const removed = await worker().reconcile(new Set(['user-1']))

      expect(removed).toBe(1)
      expect(repository.subscriptions.map((subscription) => subscription.id)).toEqual(['sub-existing'])
    })

    it('settles deliveries belonging to a reconciled-away subscription', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-orphaned', userId: 'deleted-user' }))
      repository.seedDelivery(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-orphaned', userId: 'deleted-user' }))

      await worker().reconcile(new Set())

      expect(repository.deliveries[0]?.state).toBe('permanent')
    })

    it('keeps every subscription when its owner is present', async () => {
      repository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

      const removed = await worker().reconcile(new Set(['user-1']))

      expect(removed).toBe(0)
      expect(repository.subscriptions).toHaveLength(1)
    })
  })

  describe('graceful shutdown', () => {
    it('start() then stop() resolves without ever having claimed anything, and stops scheduling further claims', async () => {
      const instance = worker()
      instance.start()
      await instance.stop()
      expect(adapter.send).not.toHaveBeenCalled()
    })
  })
})
