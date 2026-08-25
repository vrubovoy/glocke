import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, describe, expect, it } from 'vitest'
// CONTRACT: implementer must add these two drizzle-orm sqlite-core tables
// to backend/src/db/schema.ts, named and shaped exactly as asserted below
// (column names here are snake_case DB names; drizzle's TS field names on
// the table objects mirror the db/schema.ts existing camelCase
// convention - see the drizzle round-trip test at the bottom of this
// file). This is the load-bearing contract the rest of this feature's
// suite (push-repository.integration.test.ts, push-worker.test.ts,
// push-api.test.ts) all assume:
//
// push_subscriptions(id, user_id, endpoint, endpoint_hash, p256dh, auth,
//   expiration_time, provider_host, vapid_key_id, created_at, updated_at,
//   last_success_at)
//   - unique index on endpoint
//
// push_deliveries(id, event_id, source, user_id, subscription_id,
//   destination_url, state, attempts, next_attempt_at, lease_id,
//   lease_until, delivered_at, last_status, last_error)
//   - unique index on (event_id, source, subscription_id)
import { pushDeliveries, pushSubscriptions } from '../db/schema.js'

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true })
})

function freshDb(): Database.Database {
  const path = join(tmpdir(), `glocke-push-schema-${randomUUID()}.db`)
  paths.push(path)
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrate(drizzle(sqlite), { migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)) })
  return sqlite
}

describe('push_subscriptions / push_deliveries schema', () => {
  it('creates both tables with every required column and NOT NULL constraint', () => {
    const sqlite = freshDb()
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining(['push_subscriptions', 'push_deliveries']))

    const subscriptionColumns = sqlite.prepare('PRAGMA table_info(push_subscriptions)').all() as Array<{ name: string; notnull: number }>
    expect(subscriptionColumns.map((column) => column.name).sort()).toEqual([
      'auth', 'created_at', 'endpoint', 'endpoint_hash', 'expiration_time', 'id',
      'last_success_at', 'p256dh', 'provider_host', 'session_id', 'updated_at', 'user_id', 'vapid_key_id',
    ].sort())
    expect(subscriptionColumns.filter((column) => column.notnull === 1).map((column) => column.name).sort()).toEqual([
      'auth', 'created_at', 'endpoint', 'endpoint_hash', 'id', 'p256dh', 'provider_host', 'updated_at', 'user_id', 'vapid_key_id',
    ].sort())
    // Legacy rows have no session_id; browser/provider timestamps are optional.
    expect(subscriptionColumns.filter((column) => column.notnull === 0).map((column) => column.name).sort()).toEqual([
      'expiration_time', 'last_success_at', 'session_id',
    ].sort())

    const deliveryColumns = sqlite.prepare('PRAGMA table_info(push_deliveries)').all() as Array<{ name: string; notnull: number }>
    expect(deliveryColumns.map((column) => column.name).sort()).toEqual([
      'attempts', 'delivered_at', 'destination_url', 'event_id', 'id', 'last_error', 'last_status',
      'lease_id', 'lease_until', 'next_attempt_at', 'settled_at', 'source', 'state', 'subscription_id', 'user_id',
    ].sort())
    expect(deliveryColumns.filter((column) => column.notnull === 1).map((column) => column.name).sort()).toEqual([
      'attempts', 'destination_url', 'event_id', 'id', 'source', 'state', 'subscription_id', 'user_id',
    ].sort())

    sqlite.close()
  })

  it('enforces a unique index on push_subscriptions.endpoint so a duplicate endpoint cannot attach to two users', () => {
    const sqlite = freshDb()
    const now = Date.now()
    sqlite.prepare(`INSERT INTO push_subscriptions
      (id, user_id, endpoint, endpoint_hash, p256dh, auth, provider_host, vapid_key_id, created_at, updated_at)
      VALUES ('sub-1', 'user-1', 'https://fcm.googleapis.com/fcm/send/abc', 'hash-abc', 'p256dh', 'auth', 'fcm.googleapis.com', 'vapid-1', ?, ?)`)
      .run(now, now)

    expect(() => sqlite.prepare(`INSERT INTO push_subscriptions
      (id, user_id, endpoint, endpoint_hash, p256dh, auth, provider_host, vapid_key_id, created_at, updated_at)
      VALUES ('sub-2', 'user-2', 'https://fcm.googleapis.com/fcm/send/abc', 'hash-abc', 'p256dh', 'auth', 'fcm.googleapis.com', 'vapid-1', ?, ?)`)
      .run(now, now)).toThrow()

    sqlite.close()
  })

  it('enforces a unique index on push_deliveries(event_id, source, subscription_id) as the fan-out idempotency key', () => {
    const sqlite = freshDb()
    const now = Date.now()
    sqlite.prepare(`INSERT INTO push_subscriptions
      (id, user_id, endpoint, endpoint_hash, p256dh, auth, provider_host, vapid_key_id, created_at, updated_at)
      VALUES ('sub-1', 'user-1', 'https://fcm.googleapis.com/fcm/send/abc', 'hash-abc', 'p256dh', 'auth', 'fcm.googleapis.com', 'vapid-1', ?, ?)`)
      .run(now, now)
    sqlite.prepare(`INSERT INTO push_subscriptions
      (id, user_id, endpoint, endpoint_hash, p256dh, auth, provider_host, vapid_key_id, created_at, updated_at)
      VALUES ('sub-2', 'user-1', 'https://fcm.googleapis.com/fcm/send/def', 'hash-def', 'p256dh', 'auth', 'fcm.googleapis.com', 'vapid-1', ?, ?)`)
      .run(now, now)
    sqlite.prepare(`INSERT INTO push_deliveries
      (id, event_id, source, user_id, subscription_id, destination_url, state, attempts)
      VALUES ('delivery-1', 'event-1', 'tafel', 'user-1', 'sub-1', 'https://glocke.example.test/notifications', 'pending', 0)`).run()

    expect(() => sqlite.prepare(`INSERT INTO push_deliveries
      (id, event_id, source, user_id, subscription_id, destination_url, state, attempts)
      VALUES ('delivery-2', 'event-1', 'tafel', 'user-1', 'sub-1', 'https://glocke.example.test/notifications', 'pending', 0)`).run()).toThrow()

    // A different subscription for the same event/source is a separate
    // fan-out row, not a conflict - the unique key is per-subscription.
    expect(() => sqlite.prepare(`INSERT INTO push_deliveries
      (id, event_id, source, user_id, subscription_id, destination_url, state, attempts)
      VALUES ('delivery-3', 'event-1', 'tafel', 'user-1', 'sub-2', 'https://glocke.example.test/notifications', 'pending', 0)`).run()).not.toThrow()

    sqlite.close()
  })

  it('round-trips both tables through drizzle-orm - any drift between schema.ts and the committed migrations surfaces here', () => {
    const sqlite = freshDb()
    const database = drizzle(sqlite)
    const now = new Date('2026-08-07T09:00:00.000Z')

    database.insert(pushSubscriptions).values({
      id: 'sub-1', userId: 'user-1', endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      endpointHash: 'hash-abc', p256dh: 'p256dh', auth: 'auth', providerHost: 'fcm.googleapis.com',
      vapidKeyId: 'vapid-1', createdAt: now, updatedAt: now,
    }).run()
    database.insert(pushDeliveries).values({
      id: 'delivery-1', eventId: 'event-1', source: 'tafel', userId: 'user-1', subscriptionId: 'sub-1',
      destinationUrl: 'https://glocke.example.test/notifications', state: 'pending', attempts: 0,
    }).run()

    expect(database.select().from(pushSubscriptions).all()[0]).toMatchObject({
      id: 'sub-1', userId: 'user-1', vapidKeyId: 'vapid-1', expirationTime: null, lastSuccessAt: null,
    })
    expect(database.select().from(pushDeliveries).all()[0]).toMatchObject({
      id: 'delivery-1', state: 'pending', attempts: 0, leaseId: null, deliveredAt: null,
    })

    sqlite.close()
  })
})
