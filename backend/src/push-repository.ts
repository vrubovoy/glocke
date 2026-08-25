import { and, count, eq, inArray, isNotNull, isNull, lte, ne, notInArray, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schemaType from './db/schema.js'
import { pushDeliveries, pushSubscriptions } from './db/schema.js'
import type { PushDeliveryRecord, PushSubscriptionRecord } from './contracts.js'

type Database = BetterSQLite3Database<typeof schemaType>

export type PutSubscriptionResult = 'created' | 'updated' | 'conflict' | 'limit-exceeded'

export interface PushRepository {
  listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>
  listAllSubscriptions(): Promise<PushSubscriptionRecord[]>
  findSubscriptionById(id: string): Promise<PushSubscriptionRecord | null>
  findSubscriptionByEndpoint(endpoint: string): Promise<PushSubscriptionRecord | null>
  putSubscription(input: PushSubscriptionRecord, maxSubscriptionsPerUser: number): Promise<PutSubscriptionResult>
  deleteSubscription(userId: string, id: string): Promise<boolean>
  deleteBoundSubscription(userId: string, sessionId: string, id: string, endpointHash: string): Promise<boolean>
  deleteSubscriptionsForSession(userId: string, sessionId: string): Promise<number>
  deleteExpiredOrRotatedSubscriptions(now: string, vapidKeyId: string): Promise<number>
  purgeTerminalDeliveries(before: string): Promise<number>
  claimPendingDelivery(now: string, leaseUntil: string, leaseId: string): Promise<PushDeliveryRecord | null>
  markDelivered(id: string, leaseId: string, deliveredAt: string): Promise<boolean>
  markSuppressed(id: string, leaseId: string): Promise<boolean>
  markRetry(
    id: string, leaseId: string, attempts: number, nextAttemptAt: string,
    lastStatus: number | null, lastError: string,
  ): Promise<boolean>
  markPermanent(id: string, leaseId: string, attempts: number, lastStatus: number | null, lastError: string): Promise<boolean>
  touchSubscriptionSuccess(subscriptionId: string, at: string): Promise<void>
  deleteOrphanedSubscriptions(existingUserIds: ReadonlySet<string>): Promise<number>
}

function subscriptionRecord(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionRecord {
  return {
    ...row,
    expirationTime: row.expirationTime?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    sessionId: row.sessionId,
  }
}

function deliveryRecord(row: typeof pushDeliveries.$inferSelect): PushDeliveryRecord {
  return {
    ...row,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    leaseUntil: row.leaseUntil?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
  }
}

// Settles every non-terminal delivery for a subscription that's going
// away (owner-initiated delete, 404/410 cleanup, or orphan reconciliation)
// to 'permanent' so nothing is left claimable forever. Must run inside the
// same transaction as the subscription delete/reconciliation that calls it.
function settleDeliveriesForSubscription(database: Database, subscriptionId: string): void {
  database.update(pushDeliveries).set({ state: 'permanent', settledAt: new Date(), leaseId: null, leaseUntil: null }).where(and(
    eq(pushDeliveries.subscriptionId, subscriptionId),
    or(eq(pushDeliveries.state, 'pending'), eq(pushDeliveries.state, 'processing')),
  )).run()
}

export class SqlitePushRepository implements PushRepository {
  constructor(private readonly database: Database) {}

  async listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    return this.database.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all().map(subscriptionRecord)
  }

  async listAllSubscriptions(): Promise<PushSubscriptionRecord[]> {
    return this.database.select().from(pushSubscriptions).all().map(subscriptionRecord)
  }

  async findSubscriptionById(id: string): Promise<PushSubscriptionRecord | null> {
    const row = this.database.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id)).get()
    return row ? subscriptionRecord(row) : null
  }

  async findSubscriptionByEndpoint(endpoint: string): Promise<PushSubscriptionRecord | null> {
    const row = this.database.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get()
    return row ? subscriptionRecord(row) : null
  }

  async putSubscription(input: PushSubscriptionRecord, maxSubscriptionsPerUser: number): Promise<PutSubscriptionResult> {
    return this.database.transaction(() => {
      const existing = this.database.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint)).get()
      if (existing && existing.userId !== input.userId) return 'conflict' as const
      if (existing) {
        this.database.update(pushSubscriptions).set({
          p256dh: input.p256dh,
          sessionId: input.sessionId,
          auth: input.auth,
          expirationTime: input.expirationTime ? new Date(input.expirationTime) : null,
          providerHost: input.providerHost,
          vapidKeyId: input.vapidKeyId,
          updatedAt: new Date(input.updatedAt),
        }).where(eq(pushSubscriptions.id, existing.id)).run()
        return 'updated' as const
      }
      const activeForUser = this.database.select({ value: count() }).from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, input.userId)).get()?.value ?? 0
      if (activeForUser >= maxSubscriptionsPerUser) return 'limit-exceeded' as const
      this.database.insert(pushSubscriptions).values({
        ...input,
        expirationTime: input.expirationTime ? new Date(input.expirationTime) : null,
        createdAt: new Date(input.createdAt),
        updatedAt: new Date(input.updatedAt),
        lastSuccessAt: input.lastSuccessAt ? new Date(input.lastSuccessAt) : null,
      }).run()
      return 'created' as const
    })
  }

  async deleteSubscription(userId: string, id: string): Promise<boolean> {
    return this.database.transaction(() => {
      const deleted = this.database.delete(pushSubscriptions).where(and(
        eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId),
      )).run()
      if (deleted.changes !== 1) return false
      settleDeliveriesForSubscription(this.database, id)
      return true
    })
  }

  async deleteBoundSubscription(userId: string, sessionId: string, id: string, endpointHash: string): Promise<boolean> {
    return this.deleteMatchingSubscriptions(and(
      eq(pushSubscriptions.userId, userId),
      eq(pushSubscriptions.sessionId, sessionId),
      eq(pushSubscriptions.id, id),
      eq(pushSubscriptions.endpointHash, endpointHash),
    )) === 1
  }

  async deleteSubscriptionsForSession(userId: string, sessionId: string): Promise<number> {
    return this.deleteMatchingSubscriptions(and(
      eq(pushSubscriptions.userId, userId),
      eq(pushSubscriptions.sessionId, sessionId),
    ))
  }

  async deleteExpiredOrRotatedSubscriptions(now: string, vapidKeyId: string): Promise<number> {
    return this.deleteMatchingSubscriptions(or(
      and(isNotNull(pushSubscriptions.expirationTime), lte(pushSubscriptions.expirationTime, new Date(now))),
      ne(pushSubscriptions.vapidKeyId, vapidKeyId),
    ))
  }

  async purgeTerminalDeliveries(before: string): Promise<number> {
    return this.database.delete(pushDeliveries).where(and(
      or(
        eq(pushDeliveries.state, 'delivered'),
        eq(pushDeliveries.state, 'suppressed'),
        eq(pushDeliveries.state, 'permanent'),
      ),
      isNotNull(pushDeliveries.settledAt),
      lte(pushDeliveries.settledAt, new Date(before)),
    )).run().changes
  }

  private deleteMatchingSubscriptions(where: ReturnType<typeof and>): number {
    return this.database.transaction(() => {
      const rows = this.database.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(where).all()
      if (rows.length === 0) return 0
      for (const row of rows) settleDeliveriesForSubscription(this.database, row.id)
      this.database.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, rows.map((row) => row.id))).run()
      return rows.length
    })
  }

  async claimPendingDelivery(now: string, leaseUntil: string, leaseId: string): Promise<PushDeliveryRecord | null> {
    return this.database.transaction(() => {
      const claimable = and(
        or(
          eq(pushDeliveries.state, 'pending'),
          and(eq(pushDeliveries.state, 'processing'), lte(pushDeliveries.leaseUntil, new Date(now))),
        ),
        or(isNull(pushDeliveries.nextAttemptAt), lte(pushDeliveries.nextAttemptAt, new Date(now))),
      )
      const candidate = this.database.select().from(pushDeliveries).where(claimable).get()
      if (!candidate) return null
      const updated = this.database.update(pushDeliveries).set({
        state: 'processing', leaseId, leaseUntil: new Date(leaseUntil),
      }).where(and(eq(pushDeliveries.id, candidate.id), claimable)).run()
      if (updated.changes !== 1) return null
      return deliveryRecord({ ...candidate, state: 'processing', leaseId, leaseUntil: new Date(leaseUntil) })
    })
  }

  async markDelivered(id: string, leaseId: string, deliveredAt: string): Promise<boolean> {
    return this.database.update(pushDeliveries).set({
      state: 'delivered', deliveredAt: new Date(deliveredAt), settledAt: new Date(deliveredAt), leaseId: null, leaseUntil: null,
    }).where(and(eq(pushDeliveries.id, id), eq(pushDeliveries.leaseId, leaseId))).run().changes === 1
  }

  async markSuppressed(id: string, leaseId: string): Promise<boolean> {
    return this.database.update(pushDeliveries).set({
      state: 'suppressed', settledAt: new Date(), leaseId: null, leaseUntil: null,
    }).where(and(eq(pushDeliveries.id, id), eq(pushDeliveries.leaseId, leaseId))).run().changes === 1
  }

  async markRetry(
    id: string, leaseId: string, attempts: number, nextAttemptAt: string,
    lastStatus: number | null, lastError: string,
  ): Promise<boolean> {
    return this.database.update(pushDeliveries).set({
      state: 'pending', attempts, nextAttemptAt: new Date(nextAttemptAt),
      lastStatus, lastError, leaseId: null, leaseUntil: null,
    }).where(and(eq(pushDeliveries.id, id), eq(pushDeliveries.leaseId, leaseId))).run().changes === 1
  }

  async markPermanent(
    id: string, leaseId: string, attempts: number, lastStatus: number | null, lastError: string,
  ): Promise<boolean> {
    return this.database.update(pushDeliveries).set({
      state: 'permanent', attempts, lastStatus, lastError, settledAt: new Date(), leaseId: null, leaseUntil: null,
    }).where(and(eq(pushDeliveries.id, id), eq(pushDeliveries.leaseId, leaseId))).run().changes === 1
  }

  async touchSubscriptionSuccess(subscriptionId: string, at: string): Promise<void> {
    this.database.update(pushSubscriptions).set({ lastSuccessAt: new Date(at) }).where(eq(pushSubscriptions.id, subscriptionId)).run()
  }

  async deleteOrphanedSubscriptions(existingUserIds: ReadonlySet<string>): Promise<number> {
    return this.database.transaction(() => {
      const orphaned = existingUserIds.size > 0
        ? this.database.select().from(pushSubscriptions).where(notInArray(pushSubscriptions.userId, [...existingUserIds])).all()
        : this.database.select().from(pushSubscriptions).all()
      if (orphaned.length === 0) return 0
      const ids = orphaned.map((row) => row.id)
      this.database.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, ids)).run()
      for (const id of ids) settleDeliveriesForSubscription(this.database, id)
      return orphaned.length
    })
  }
}
