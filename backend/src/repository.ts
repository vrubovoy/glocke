import { and, asc, count, desc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schemaType from './db/schema.js'
import { inboxEvents, notifications, pushDeliveries, pushSubscriptions, userTombstones } from './db/schema.js'
import type {
  EventEnvelope, InboxRecord, NotificationPage, NotificationRecord, NotificationRepository,
  PushDeliveryRecord, PushSubscriptionRecord,
} from './contracts.js'

type Database = BetterSQLite3Database<typeof schemaType>

function cursorEncode(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url')
}

function cursorDecode(cursor: string): [Date, string] | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') return null
    const date = new Date(value[0])
    return Number.isNaN(date.getTime()) ? null : [date, value[1]]
  } catch {
    return null
  }
}

function inboxRecord(row: typeof inboxEvents.$inferSelect): InboxRecord {
  let envelope: EventEnvelope
  try {
    envelope = JSON.parse(row.envelope) as EventEnvelope
  } catch {
    // Preserve row identity so the processor can lease-fence and suppress it.
    envelope = null as unknown as EventEnvelope
  }
  return {
    eventId: row.eventId,
    source: row.source,
    userId: row.userId,
    payloadHash: row.payloadHash,
    envelope,
    status: row.status,
    acceptedAt: row.acceptedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    leaseUntil: row.leaseUntil?.toISOString() ?? null,
    leaseId: row.leaseId,
  }
}

function notificationRecord(row: typeof notifications.$inferSelect): NotificationRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  }
}

function pushSubscriptionRecord(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionRecord {
  return {
    ...row,
    expirationTime: row.expirationTime?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
  }
}

export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly database: Database) {}

  async acceptInbox(record: InboxRecord): Promise<'accepted' | 'duplicate' | 'conflict'> {
    return this.database.transaction(() => {
      const tombstone = this.database.select({ userId: userTombstones.userId }).from(userTombstones)
        .where(eq(userTombstones.userId, record.userId)).get()
      if (tombstone) return 'accepted' as const
      const inserted = this.database.insert(inboxEvents).values({
        source: record.source,
        eventId: record.eventId,
        userId: record.userId,
        payloadHash: record.payloadHash,
        envelope: JSON.stringify(record.envelope),
        status: record.status,
        acceptedAt: new Date(record.acceptedAt),
      }).onConflictDoNothing().run()
      if (inserted.changes === 1) return 'accepted' as const
      const existing = this.database.select({ payloadHash: inboxEvents.payloadHash }).from(inboxEvents).where(and(
        eq(inboxEvents.source, record.source), eq(inboxEvents.eventId, record.eventId),
      )).get()
      return existing?.payloadHash === record.payloadHash ? 'duplicate' as const : 'conflict' as const
    })
  }

  async claimPendingInbox(now: string, leaseUntil: string, leaseId: string): Promise<InboxRecord | null> {
    const claimed = this.database.transaction(() => {
      const candidate = this.database.select().from(inboxEvents).where(or(
        eq(inboxEvents.status, 'pending'),
        and(eq(inboxEvents.status, 'processing'), lte(inboxEvents.leaseUntil, new Date(now))),
      )).orderBy(asc(inboxEvents.acceptedAt), asc(inboxEvents.eventId)).get()
      if (!candidate) return null
      const updated = this.database.update(inboxEvents).set({
        status: 'processing', leaseUntil: new Date(leaseUntil), leaseId,
      }).where(and(
        eq(inboxEvents.source, candidate.source),
        eq(inboxEvents.eventId, candidate.eventId),
        or(
          eq(inboxEvents.status, 'pending'),
          and(eq(inboxEvents.status, 'processing'), lte(inboxEvents.leaseUntil, new Date(now))),
        ),
      )).run()
      if (updated.changes !== 1) return null
      return { ...candidate, status: 'processing' as const, leaseUntil: new Date(leaseUntil), leaseId }
    })
    return claimed ? inboxRecord(claimed) : null
  }

  async markInboxProcessed(source: string, eventId: string, leaseId: string, processedAt: string): Promise<boolean> {
    return this.database.update(inboxEvents).set({
      status: 'processed', processedAt: new Date(processedAt), leaseUntil: null, leaseId: null,
    }).where(and(
      eq(inboxEvents.source, source), eq(inboxEvents.eventId, eventId),
      eq(inboxEvents.status, 'processing'), eq(inboxEvents.leaseId, leaseId),
      gt(inboxEvents.leaseUntil, new Date(processedAt)),
    )).run().changes === 1
  }

  async createNotification(record: NotificationRecord, leaseId: string, now: string): Promise<'created' | 'duplicate' | 'stale'> {
    return this.database.transaction(() => {
      const claim = this.database.select({ leaseId: inboxEvents.leaseId, userId: inboxEvents.userId }).from(inboxEvents).where(and(
        eq(inboxEvents.source, record.source), eq(inboxEvents.eventId, record.eventId),
        eq(inboxEvents.status, 'processing'), eq(inboxEvents.leaseId, leaseId),
        gt(inboxEvents.leaseUntil, new Date(now)),
      )).get()
      if (!claim) return 'stale' as const
      const tombstone = this.database.select({ userId: userTombstones.userId }).from(userTombstones)
        .where(eq(userTombstones.userId, claim.userId)).get()
      if (tombstone) {
        this.database.delete(inboxEvents).where(and(
          eq(inboxEvents.source, record.source), eq(inboxEvents.eventId, record.eventId),
        )).run()
        return 'duplicate' as const
      }
      const result = this.database.insert(notifications).values({
        ...record,
        createdAt: new Date(record.createdAt),
        readAt: record.readAt ? new Date(record.readAt) : null,
      }).onConflictDoNothing().run()
      return result.changes === 1 ? 'created' as const : 'duplicate' as const
    })
  }

  async listNotifications(userId: string, cursor: string | null, limit: number): Promise<NotificationPage> {
    const decoded = cursor ? cursorDecode(cursor) : null
    const rows = this.database.select().from(notifications).where(and(
      eq(notifications.userId, userId),
      decoded ? or(
        lt(notifications.createdAt, decoded[0]),
        and(eq(notifications.createdAt, decoded[0]), lt(notifications.id, decoded[1])),
      ) : undefined,
    )).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit + 1).all()
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(notificationRecord)
    const last = items.at(-1)
    return { items, nextCursor: hasMore && last ? cursorEncode(last.createdAt, last.id) : null }
  }

  async exportNotifications(userId: string): Promise<NotificationRecord[]> {
    return this.database.select().from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .all()
      .map(notificationRecord)
  }

  async unreadCount(userId: string): Promise<number> {
    return this.database.select({ value: count() }).from(notifications).where(and(
      eq(notifications.userId, userId), isNull(notifications.readAt),
    )).get()?.value ?? 0
  }

  async markRead(userId: string, notificationId: string, readAt: string): Promise<NotificationRecord | null> {
    this.database.update(notifications).set({ readAt: new Date(readAt) }).where(and(
      eq(notifications.id, notificationId), eq(notifications.userId, userId), isNull(notifications.readAt),
    )).run()
    const row = this.database.select().from(notifications).where(and(
      eq(notifications.id, notificationId), eq(notifications.userId, userId),
    )).get()
    return row ? notificationRecord(row) : null
  }

  async markAllRead(userId: string, readAt: string): Promise<number> {
    return this.database.update(notifications).set({ readAt: new Date(readAt) }).where(and(
      eq(notifications.userId, userId), isNull(notifications.readAt),
    )).run().changes
  }

  async deleteNotification(userId: string, notificationId: string): Promise<boolean> {
    return this.database.delete(notifications).where(and(
      eq(notifications.id, notificationId), eq(notifications.userId, userId),
    )).run().changes === 1
  }

  async deleteAllNotifications(userId: string): Promise<number> {
    return this.database.delete(notifications).where(
      eq(notifications.userId, userId),
    ).run().changes
  }

  async listActiveSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    return this.database.select().from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all()
      .map(pushSubscriptionRecord)
  }

  async materializeNotification(input: {
    source: string
    eventId: string
    leaseId: string
    now: string
    notification: NotificationRecord | null
    pushDeliveries: PushDeliveryRecord[]
  }): Promise<'materialized' | 'stale'> {
    return this.database.transaction(() => {
      const claim = this.database.select({ leaseId: inboxEvents.leaseId, userId: inboxEvents.userId }).from(inboxEvents).where(and(
        eq(inboxEvents.source, input.source), eq(inboxEvents.eventId, input.eventId),
        eq(inboxEvents.status, 'processing'), eq(inboxEvents.leaseId, input.leaseId),
        gt(inboxEvents.leaseUntil, new Date(input.now)),
      )).get()
      if (!claim) return 'stale' as const
      const tombstone = this.database.select({ userId: userTombstones.userId }).from(userTombstones)
        .where(eq(userTombstones.userId, claim.userId)).get()
      if (tombstone) {
        this.database.delete(inboxEvents).where(and(
          eq(inboxEvents.source, input.source), eq(inboxEvents.eventId, input.eventId),
        )).run()
        return 'materialized' as const
      }

      if (input.notification) {
        const record = input.notification
        this.database.insert(notifications).values({
          ...record,
          createdAt: new Date(record.createdAt),
          readAt: record.readAt ? new Date(record.readAt) : null,
        }).onConflictDoNothing().run()
      }

      for (const delivery of input.pushDeliveries) {
        this.database.insert(pushDeliveries).values({
          ...delivery,
          nextAttemptAt: delivery.nextAttemptAt ? new Date(delivery.nextAttemptAt) : null,
          leaseUntil: delivery.leaseUntil ? new Date(delivery.leaseUntil) : null,
          deliveredAt: delivery.deliveredAt ? new Date(delivery.deliveredAt) : null,
          settledAt: delivery.settledAt ? new Date(delivery.settledAt) : null,
        }).onConflictDoNothing().run()
      }

      return 'materialized' as const
    })
  }
}
