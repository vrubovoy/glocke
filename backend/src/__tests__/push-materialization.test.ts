import { beforeEach, describe, expect, it } from 'vitest'
import { createProcessor } from '../processor.js'
import { eventEnvelope, inboxRecord } from './helpers/fixtures.js'
import { pushSubscriptionRecord } from './helpers/push-fixtures.js'
import { MemoryNotificationRepository } from './helpers/repository.js'

// CONTRACT: processor.ts's CreateProcessorOptions gains two new fields:
//
//   createPushDeliveryId?: () => string   // id generator for push_deliveries rows, mirrors createId
//   glockeOrigin?: string                 // Glocke's own public origin
//
// and its recipient gate changes from `if (recipient?.notifyInApp)` to
// "render once if EITHER notifyInApp or notifyBrowserPush is true; insert
// a notification row only if notifyInApp; insert one push_deliveries row
// per row from repository.listActiveSubscriptions(event.userId) only if
// notifyBrowserPush; both writes go through the single
// repository.materializeNotification(...) call (see helpers/repository.ts
// for its exact signature)". When neither flag is set, behavior is
// unchanged from today: mark the inbox event processed, create nothing.
//
// destinationUrl resolution (push_deliveries.destinationUrl): the same
// rendered actionUrl used for the in-app notification, already absolute
// when a sourceOrigin applies (kuvert/tafel, exactly like today); when the
// resolved actionUrl is null (no domain link) or still a relative path
// (e.g. schlussel's '/settings'), it must be resolved into an absolute
// URL against `glockeOrigin`, falling back to `${glockeOrigin}/notifications`
// when there is no actionUrl at all. A push delivery's destination must
// always be an absolute URL - the service worker cannot resolve a
// relative one against an unknown origin.
describe('push materialization', () => {
  let repository: MemoryNotificationRepository

  beforeEach(() => {
    repository = new MemoryNotificationRepository()
  })

  function processor(
    recipient: { notifyInApp: boolean; notifyBrowserPush: boolean },
    extra: { sourceOrigins?: { kuvert: string; tafel: string } } = {},
  ) {
    let deliveryIndex = 0
    return createProcessor({
      repository,
      resolveRecipient: async (userId) => ({ userId, ...recipient }),
      now: () => new Date('2026-08-07T10:00:02.000Z'),
      createId: () => 'notification-1',
      createPushDeliveryId: () => `delivery-${deliveryIndex += 1}`,
      createLeaseId: () => 'lease-1',
      glockeOrigin: 'https://glocke.example.test',
      sourceOrigins: extra.sourceOrigins,
    })
  }

  it('enqueues both an in-app notification and a push delivery atomically when both channels are on', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor({ notifyInApp: true, notifyBrowserPush: true }).processNext()).toBe('processed')

    expect(repository.notifications).toHaveLength(1)
    expect(repository.pushDeliveries).toHaveLength(1)
    expect(repository.pushDeliveries[0]).toMatchObject({
      eventId: '10000000-0000-4000-8000-000000000001',
      source: 'tafel',
      userId: 'user-1',
      subscriptionId: 'sub-1',
      state: 'pending',
      attempts: 0,
    })
  })

  it('enqueues push only when notifyInApp is false and notifyBrowserPush is true', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor({ notifyInApp: false, notifyBrowserPush: true }).processNext()).toBe('processed')

    expect(repository.notifications).toHaveLength(0)
    expect(repository.pushDeliveries).toHaveLength(1)
  })

  it('enqueues an in-app notification only when notifyInApp is true and notifyBrowserPush is false', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor({ notifyInApp: true, notifyBrowserPush: false }).processNext()).toBe('processed')

    expect(repository.notifications).toHaveLength(1)
    expect(repository.pushDeliveries).toHaveLength(0)
  })

  it('creates neither row when both channels are off, but still marks the event processed', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor({ notifyInApp: false, notifyBrowserPush: false }).processNext()).toBe('processed')

    expect(repository.notifications).toHaveLength(0)
    expect(repository.pushDeliveries).toHaveLength(0)
    expect(repository.inbox[0]).toMatchObject({ status: 'processed' })
  })

  it('gives every currently-active subscription its own delivery row (fan-out) and only for its owner', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.seedPushSubscription(pushSubscriptionRecord({
      id: 'sub-2', userId: 'user-1', endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/other',
    }))
    repository.seedPushSubscription(pushSubscriptionRecord({
      id: 'sub-other-user', userId: 'user-2', endpoint: 'https://fcm.googleapis.com/fcm/send/other-user',
    }))

    expect(await processor({ notifyInApp: false, notifyBrowserPush: true }).processNext()).toBe('processed')

    expect(repository.pushDeliveries.map((delivery) => delivery.subscriptionId).sort()).toEqual(['sub-1', 'sub-2'])
    expect(repository.pushDeliveries.every((delivery) => delivery.userId === 'user-1')).toBe(true)
  })

  it('does not retroactively create a delivery for a subscription registered after the event was already processed', async () => {
    repository.seedInbox(inboxRecord())

    expect(await processor({ notifyInApp: false, notifyBrowserPush: true }).processNext()).toBe('processed')
    expect(repository.pushDeliveries).toHaveLength(0)

    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'late-sub', userId: 'user-1' }))
    // Nothing left to claim - the event is already processed, so a later
    // pass is idle rather than re-materializing anything for it.
    expect(await processor({ notifyInApp: false, notifyBrowserPush: true }).processNext()).toBe('idle')
    expect(repository.pushDeliveries).toHaveLength(0)
  })

  it('is idempotent when materialization committed but inbox completion failed (crash recovery)', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
    repository.failNextCompletion = true
    const worker = processor({ notifyInApp: true, notifyBrowserPush: true })

    await expect(worker.processNext()).rejects.toThrow('simulated completion failure')
    expect(repository.notifications).toHaveLength(1)
    expect(repository.pushDeliveries).toHaveLength(1)
    repository.recoverProcessing()

    expect(await worker.processNext()).toBe('processed')
    expect(repository.notifications).toHaveLength(1)
    expect(repository.pushDeliveries).toHaveLength(1)
    expect(repository.inbox[0]?.status).toBe('processed')
  })

  it('falls back to the Glocke notifications page as the push destination when the event has no actionUrl', async () => {
    const envelope = eventEnvelope({
      source: 'zettel',
      type: 'zettel.note.backlink_added.v1',
      payload: { recipientId: 'user-1', sourceTitle: 'Архитектура', targetTitle: 'Glocke' },
    })
    repository.seedInbox(inboxRecord({ envelope, source: 'zettel' }))
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor({ notifyInApp: false, notifyBrowserPush: true }).processNext()).toBe('processed')

    expect(repository.pushDeliveries[0]?.destinationUrl).toBe('https://glocke.example.test/notifications')
  })

  it('resolves an absolute source-origin actionUrl unchanged as the push destination', async () => {
    repository.seedInbox(inboxRecord()) // default fixture: tafel.task.due.v1
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor(
      { notifyInApp: false, notifyBrowserPush: true },
      { sourceOrigins: { kuvert: 'https://kuvert.example.test', tafel: 'https://tafel.example.test' } },
    ).processNext()).toBe('processed')

    expect(repository.pushDeliveries[0]?.destinationUrl).toBe('https://tafel.example.test/tasks')
  })

  it('resolves a relative actionUrl against glockeOrigin when no source origin applies', async () => {
    const envelope = eventEnvelope({
      source: 'schlussel', type: 'schlussel.security.password_changed.v1', payload: { recipientId: 'user-1' },
    })
    repository.seedInbox(inboxRecord({ envelope, source: 'schlussel' }))
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor({ notifyInApp: false, notifyBrowserPush: true }).processNext()).toBe('processed')

    expect(repository.pushDeliveries[0]?.destinationUrl).toBe('https://glocke.example.test/settings')
  })

  it('never stores event title/body on a push delivery row - only the resolved destination URL', async () => {
    repository.seedInbox(inboxRecord())
    repository.seedPushSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

    expect(await processor({ notifyInApp: false, notifyBrowserPush: true }).processNext()).toBe('processed')

    expect(Object.keys(repository.pushDeliveries[0]!).sort()).toEqual([
      'attempts', 'deliveredAt', 'destinationUrl', 'eventId', 'id', 'lastError', 'lastStatus',
      'leaseId', 'leaseUntil', 'nextAttemptAt', 'settledAt', 'source', 'state', 'subscriptionId', 'userId',
    ].sort())
  })
})
