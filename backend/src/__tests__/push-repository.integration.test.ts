import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// CONTRACT: backend/src/push-repository.ts exports `SqlitePushRepository`,
// constructed the same way as `SqliteNotificationRepository`
// (backend/src/repository.ts) - `new SqlitePushRepository(database)` over
// the same drizzle-orm BetterSQLite3Database<typeof schema>. See
// helpers/push-repository.ts's MemoryPushRepository fake (used by
// push-worker.test.ts and push-api.test.ts) for the exact method list
// this class must implement; this file is the real-SQLite behavioral
// contract for the subset that has DB-level semantics (uniqueness,
// cascade-on-delete, lease fencing).
import * as schema from '../db/schema.js'
import { SqlitePushRepository } from '../push-repository.js'
import { pushDeliveryRecord, pushSubscriptionRecord, type PushDeliveryRecord } from './helpers/push-fixtures.js'

// Raw seed inserts below go straight through drizzle, which expects Date
// objects for timestamp-mode columns - pushDeliveryRecord() itself returns
// the wire shape (ISO strings), matching every other repository fixture in
// this suite, so this converts just for the direct schema.pushDeliveries
// insert calls.
function deliveryRow(record: PushDeliveryRecord) {
  return {
    ...record,
    nextAttemptAt: record.nextAttemptAt ? new Date(record.nextAttemptAt) : null,
    leaseUntil: record.leaseUntil ? new Date(record.leaseUntil) : null,
    deliveredAt: record.deliveredAt ? new Date(record.deliveredAt) : null,
    settledAt: record.settledAt ? new Date(record.settledAt) : null,
  }
}

describe('SqlitePushRepository', () => {
  let path: string
  let sqlite: Database.Database
  let database: ReturnType<typeof drizzle<typeof schema>>
  let repository: SqlitePushRepository

  beforeEach(() => {
    path = join(tmpdir(), `glocke-push-repository-${randomUUID()}.db`)
    sqlite = new Database(path)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    database = drizzle(sqlite, { schema })
    migrate(database, { migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)) })
    repository = new SqlitePushRepository(database)
  })

  afterEach(() => {
    sqlite.close()
    rmSync(path, { force: true })
    rmSync(`${path}-shm`, { force: true })
    rmSync(`${path}-wal`, { force: true })
  })

  it('creates a subscription and lists it back only for its owner', async () => {
    expect(await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }), 10)).toBe('created')

    expect((await repository.listSubscriptions('user-1')).map((subscription) => subscription.id)).toEqual(['sub-1'])
    expect(await repository.listSubscriptions('user-2')).toEqual([])
  })

  it('rejects moving an existing endpoint to a different owner instead of overwriting it', async () => {
    const sharedEndpoint = 'https://fcm.googleapis.com/fcm/send/shared'
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1', endpoint: sharedEndpoint }), 10)

    const result = await repository.putSubscription(
      pushSubscriptionRecord({ id: 'sub-2', userId: 'user-2', endpoint: sharedEndpoint }), 10,
    )

    expect(result).toBe('conflict')
    expect(await repository.listSubscriptions('user-2')).toEqual([])
    expect((await repository.listSubscriptions('user-1'))[0]?.id).toBe('sub-1')
  })

  it('re-registering the same endpoint for its own owner updates rather than duplicates', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/mine'
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1', endpoint, p256dh: 'old-p256dh' }), 10)

    const result = await repository.putSubscription(
      pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1', endpoint, p256dh: 'new-p256dh' }), 10,
    )

    expect(result).toBe('updated')
    const subscriptions = await repository.listSubscriptions('user-1')
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]?.p256dh).toBe('new-p256dh')
  })

  it('allows exactly the configured maximum active subscriptions per user and rejects the one after', async () => {
    for (let index = 0; index < 10; index += 1) {
      const result = await repository.putSubscription(pushSubscriptionRecord({
        id: `sub-${index}`, userId: 'user-1', endpoint: `https://fcm.googleapis.com/fcm/send/${index}`,
      }), 10)
      expect(result).toBe('created')
    }

    const overLimit = await repository.putSubscription(pushSubscriptionRecord({
      id: 'sub-over-limit', userId: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/over-limit',
    }), 10)

    expect(overLimit).toBe('limit-exceeded')
    expect(await repository.listSubscriptions('user-1')).toHaveLength(10)
  })

  it('deletes only the owner-matched subscription and is idempotent', async () => {
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }), 10)

    expect(await repository.deleteSubscription('user-2', 'sub-1')).toBe(false)
    expect(await repository.deleteSubscription('user-1', 'sub-1')).toBe(true)
    expect(await repository.deleteSubscription('user-1', 'sub-1')).toBe(false)
    expect(await repository.listSubscriptions('user-1')).toEqual([])
  })

  it('settles related pending and processing deliveries to a terminal state when their subscription is deleted, and leaves already-terminal rows alone', async () => {
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }), 10)
    database.insert(schema.pushDeliveries).values([
      deliveryRow(pushDeliveryRecord({ id: 'delivery-pending', subscriptionId: 'sub-1', userId: 'user-1', eventId: 'event-1' })),
      deliveryRow(pushDeliveryRecord({
        id: 'delivery-processing', subscriptionId: 'sub-1', userId: 'user-1', eventId: 'event-2',
        state: 'processing', leaseId: 'lease-x', leaseUntil: '2026-08-07T10:05:00.000Z',
      })),
      deliveryRow(pushDeliveryRecord({
        id: 'delivery-delivered', subscriptionId: 'sub-1', userId: 'user-1', eventId: 'event-3',
        state: 'delivered', attempts: 1, deliveredAt: '2026-08-07T09:00:00.000Z',
      })),
    ]).run()

    await repository.deleteSubscription('user-1', 'sub-1')

    const remaining = database.select().from(schema.pushDeliveries).all()
    expect(remaining.find((delivery) => delivery.id === 'delivery-pending')?.state).not.toBe('pending')
    expect(remaining.find((delivery) => delivery.id === 'delivery-processing')?.state).not.toBe('processing')
    expect(remaining.find((delivery) => delivery.id === 'delivery-delivered')?.state).toBe('delivered')
    // A settled delivery must never remain claimable by a future worker pass.
    expect(await repository.claimPendingDelivery(
      '2026-08-07T11:00:00.000Z', '2026-08-07T11:00:30.000Z', 'later-lease',
    )).toBeNull()
  })

  it('recovers an expired claim and fences a stale settle attempt behind the newer lease', async () => {
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }), 10)
    database.insert(schema.pushDeliveries).values(deliveryRow(pushDeliveryRecord({ id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1' }))).run()

    const first = await repository.claimPendingDelivery('2026-08-07T10:00:00.000Z', '2026-08-07T10:00:10.000Z', 'lease-old')
    expect(first?.id).toBe('delivery-1')
    expect(await repository.claimPendingDelivery('2026-08-07T10:00:05.000Z', '2026-08-07T10:00:15.000Z', 'lease-early')).toBeNull()

    const renewed = await repository.claimPendingDelivery('2026-08-07T10:00:11.000Z', '2026-08-07T10:00:21.000Z', 'lease-new')
    expect(renewed?.id).toBe('delivery-1')

    expect(await repository.markDelivered('delivery-1', 'lease-old', '2026-08-07T10:00:12.000Z')).toBe(false)
    expect(await repository.markDelivered('delivery-1', 'lease-new', '2026-08-07T10:00:12.000Z')).toBe(true)
  })

  it('does not reclaim a pending delivery before its scheduled nextAttemptAt', async () => {
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }), 10)
    database.insert(schema.pushDeliveries).values(deliveryRow(pushDeliveryRecord({
      id: 'delivery-1', subscriptionId: 'sub-1', userId: 'user-1', nextAttemptAt: '2026-08-07T11:00:00.000Z',
    }))).run()

    expect(await repository.claimPendingDelivery(
      '2026-08-07T10:00:00.000Z', '2026-08-07T10:00:30.000Z', 'lease-1',
    )).toBeNull()
    expect(await repository.claimPendingDelivery(
      '2026-08-07T11:00:01.000Z', '2026-08-07T11:00:31.000Z', 'lease-2',
    )).not.toBeNull()
  })

  it('deletes subscriptions for accounts no longer present and settles their deliveries', async () => {
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-keep', userId: 'user-1' }), 10)
    await repository.putSubscription(pushSubscriptionRecord({
      id: 'sub-orphan', userId: 'deleted-user', endpoint: 'https://fcm.googleapis.com/fcm/send/orphan',
    }), 10)
    database.insert(schema.pushDeliveries).values(deliveryRow(pushDeliveryRecord({ id: 'delivery-orphan', subscriptionId: 'sub-orphan', userId: 'deleted-user' }))).run()

    const removed = await repository.deleteOrphanedSubscriptions(new Set(['user-1']))

    expect(removed).toBe(1)
    expect((await repository.listSubscriptions('user-1')).map((subscription) => subscription.id)).toEqual(['sub-keep'])
    expect(database.select().from(schema.pushDeliveries).all().find((delivery) => delivery.id === 'delivery-orphan')?.state).not.toBe('pending')
  })

  it('records lastSuccessAt on the subscription when touched', async () => {
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }), 10)

    await repository.touchSubscriptionSuccess('sub-1', '2026-08-07T12:00:00.000Z')

    expect((await repository.listSubscriptions('user-1'))[0]?.lastSuccessAt).toBe('2026-08-07T12:00:00.000Z')
  })

  it('purges only terminal deliveries older than the retention cutoff', async () => {
    await repository.putSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }), 10)
    database.insert(schema.pushDeliveries).values([
      deliveryRow(pushDeliveryRecord({ id: 'old', state: 'permanent', settledAt: '2026-07-01T00:00:00.000Z' })),
      deliveryRow(pushDeliveryRecord({ id: 'new', eventId: 'event-new', state: 'delivered', settledAt: '2026-08-07T00:00:00.000Z' })),
      deliveryRow(pushDeliveryRecord({ id: 'pending', eventId: 'event-pending', settledAt: '2026-07-01T00:00:00.000Z' })),
    ]).run()

    expect(await repository.purgeTerminalDeliveries('2026-08-01T00:00:00.000Z')).toBe(1)
    expect(database.select({ id: schema.pushDeliveries.id }).from(schema.pushDeliveries).all()).toEqual([
      { id: 'new' }, { id: 'pending' },
    ])
  })
})
