import type { PushDeliveryRecord, PushSubscriptionRecord } from './push-fixtures.js'

// CONTRACT: this is the in-memory test double for the `PushRepository`
// interface backend/src/push-repository.ts must export (implemented for
// real by `SqlitePushRepository` over the `push_subscriptions` /
// `push_deliveries` tables - see push-schema.test.ts for their exact
// column shape and push-repository.integration.test.ts for the SQLite
// implementation's own behavioral contract). Every method here mirrors
// what push-worker.test.ts and push-api.test.ts assume exists, spelled
// exactly the way this repo already spells the equivalent inbox idiom in
// SqliteNotificationRepository (claimPendingInbox / markInboxProcessed
// lease fencing).
export type PutSubscriptionResult = 'created' | 'updated' | 'conflict' | 'limit-exceeded'

export class MemoryPushRepository {
  readonly subscriptions: PushSubscriptionRecord[] = []
  readonly deliveries: PushDeliveryRecord[] = []

  async listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    return structuredClone(this.subscriptions.filter((subscription) => subscription.userId === userId))
  }

  async listAllSubscriptions(): Promise<PushSubscriptionRecord[]> {
    return structuredClone(this.subscriptions)
  }

  async findSubscriptionById(id: string): Promise<PushSubscriptionRecord | null> {
    const found = this.subscriptions.find((subscription) => subscription.id === id)
    return found ? structuredClone(found) : null
  }

  async findSubscriptionByEndpoint(endpoint: string): Promise<PushSubscriptionRecord | null> {
    const found = this.subscriptions.find((subscription) => subscription.endpoint === endpoint)
    return found ? structuredClone(found) : null
  }

  // A duplicate endpoint for the SAME owner updates in place (re-subscribe
  // after a browser-rotated key); a duplicate endpoint for a DIFFERENT
  // owner is a conflict, never silently reattached. The per-user cap is
  // enforced only against genuinely new rows.
  async putSubscription(input: PushSubscriptionRecord, maxSubscriptionsPerUser: number): Promise<PutSubscriptionResult> {
    const existingByEndpoint = this.subscriptions.find((subscription) => subscription.endpoint === input.endpoint)
    if (existingByEndpoint && existingByEndpoint.userId !== input.userId) return 'conflict'
    if (existingByEndpoint) {
      // Mirrors SqlitePushRepository's own update field list exactly - id,
      // userId, endpoint, endpointHash, createdAt, and lastSuccessAt are
      // the EXISTING row's own identity/history, never overwritten by a
      // re-subscribe.
      Object.assign(existingByEndpoint, {
        p256dh: input.p256dh,
        sessionId: input.sessionId,
        auth: input.auth,
        expirationTime: input.expirationTime,
        providerHost: input.providerHost,
        vapidKeyId: input.vapidKeyId,
        updatedAt: input.updatedAt,
      })
      return 'updated'
    }
    const activeForUser = this.subscriptions.filter((subscription) => subscription.userId === input.userId).length
    if (activeForUser >= maxSubscriptionsPerUser) return 'limit-exceeded'
    this.subscriptions.push(structuredClone(input))
    return 'created'
  }

  // Owner-scoped delete, reused both by the authenticated DELETE route and
  // by the push worker's own 404/410 cleanup (the worker always knows the
  // delivery's userId, so it can call this exactly the same way). Cascades
  // every related pending/processing delivery to a terminal state so
  // nothing is left claimable forever.
  async deleteSubscription(userId: string, id: string): Promise<boolean> {
    const index = this.subscriptions.findIndex((subscription) => subscription.id === id && subscription.userId === userId)
    if (index < 0) return false
    const [removed] = this.subscriptions.splice(index, 1)
    for (const delivery of this.deliveries) {
      if (delivery.subscriptionId === removed!.id && (delivery.state === 'pending' || delivery.state === 'processing')) {
        delivery.state = 'permanent'
        delivery.leaseId = null
        delivery.leaseUntil = null
      }
    }
    return true
  }

  async deleteBoundSubscription(userId: string, sessionId: string, id: string, endpointHash: string): Promise<boolean> {
    const subscription = this.subscriptions.find((candidate) => (
      candidate.id === id && candidate.userId === userId && candidate.sessionId === sessionId && candidate.endpointHash === endpointHash
    ))
    return subscription ? this.deleteSubscription(userId, id) : false
  }

  async deleteSubscriptionsForSession(userId: string, sessionId: string): Promise<number> {
    const matching = this.subscriptions.filter((candidate) => candidate.userId === userId && candidate.sessionId === sessionId)
    for (const subscription of matching) await this.deleteSubscription(userId, subscription.id)
    return matching.length
  }

  async deleteExpiredOrRotatedSubscriptions(now: string, vapidKeyId: string): Promise<number> {
    const matching = this.subscriptions.filter((candidate) => (
      (candidate.expirationTime !== null && candidate.expirationTime <= now) || candidate.vapidKeyId !== vapidKeyId
    ))
    for (const subscription of matching) await this.deleteSubscription(subscription.userId, subscription.id)
    return matching.length
  }

  async purgeTerminalDeliveries(before: string): Promise<number> {
    const retained = this.deliveries.filter((delivery) => !(
      delivery.settledAt && delivery.settledAt <= before && ['delivered', 'suppressed', 'permanent'].includes(delivery.state)
    ))
    const purged = this.deliveries.length - retained.length
    this.deliveries.splice(0, this.deliveries.length, ...retained)
    return purged
  }

  async claimPendingDelivery(now: string, leaseUntil: string, leaseId: string): Promise<PushDeliveryRecord | null> {
    const record = this.deliveries.find((delivery) => (
      (delivery.state === 'pending' || (delivery.state === 'processing' && delivery.leaseUntil !== null && delivery.leaseUntil < now))
      && (delivery.nextAttemptAt === null || delivery.nextAttemptAt <= now)
    ))
    if (!record) return null
    record.state = 'processing'
    record.leaseId = leaseId
    record.leaseUntil = leaseUntil
    return structuredClone(record)
  }

  async markDelivered(id: string, leaseId: string, deliveredAt: string): Promise<boolean> {
    const record = this.deliveries.find((delivery) => delivery.id === id && delivery.leaseId === leaseId)
    if (!record) return false
    record.state = 'delivered'
    record.deliveredAt = deliveredAt
    record.leaseId = null
    record.leaseUntil = null
    return true
  }

  async markSuppressed(id: string, leaseId: string): Promise<boolean> {
    const record = this.deliveries.find((delivery) => delivery.id === id && delivery.leaseId === leaseId)
    if (!record) return false
    record.state = 'suppressed'
    record.leaseId = null
    record.leaseUntil = null
    return true
  }

  async markRetry(
    id: string, leaseId: string, attempts: number, nextAttemptAt: string,
    lastStatus: number | null, lastError: string,
  ): Promise<boolean> {
    const record = this.deliveries.find((delivery) => delivery.id === id && delivery.leaseId === leaseId)
    if (!record) return false
    record.state = 'pending'
    record.attempts = attempts
    record.nextAttemptAt = nextAttemptAt
    record.lastStatus = lastStatus
    record.lastError = lastError
    record.leaseId = null
    record.leaseUntil = null
    return true
  }

  async markPermanent(
    id: string, leaseId: string, attempts: number, lastStatus: number | null, lastError: string,
  ): Promise<boolean> {
    const record = this.deliveries.find((delivery) => delivery.id === id && delivery.leaseId === leaseId)
    if (!record) return false
    record.state = 'permanent'
    record.attempts = attempts
    record.lastStatus = lastStatus
    record.lastError = lastError
    record.leaseId = null
    record.leaseUntil = null
    return true
  }

  async touchSubscriptionSuccess(subscriptionId: string, at: string): Promise<void> {
    const subscription = this.subscriptions.find((candidate) => candidate.id === subscriptionId)
    if (subscription) subscription.lastSuccessAt = at
  }

  async deleteOrphanedSubscriptions(existingUserIds: ReadonlySet<string>): Promise<number> {
    const orphaned = this.subscriptions.filter((subscription) => !existingUserIds.has(subscription.userId))
    for (const subscription of orphaned) await this.deleteSubscription(subscription.userId, subscription.id)
    return orphaned.length
  }

  seedSubscription(record: PushSubscriptionRecord): void {
    this.subscriptions.push(structuredClone(record))
  }

  seedDelivery(record: PushDeliveryRecord): void {
    this.deliveries.push(structuredClone(record))
  }
}
