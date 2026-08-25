import { calculateBackoffDelay, classifyNotificationResponse } from '@zudar107/schloss-server-kit'
import type { PushRepository } from './push-repository.js'
import type { ResolveRecipient } from './contracts.js'

export interface PushAdapterSendArgs {
  subscription: { endpoint: string; p256dh: string; auth: string }
  payload: { id: string; text: string; url: string }
  vapid: { publicKey: string; privateKey: string; subject: string }
  timeoutMs: number
}

export type PushAdapterSendResult =
  | { outcome: 'sent'; status: number; retryAfterMs?: number }
  | { outcome: 'timeout' }
  | { outcome: 'network-error'; message: string }

export interface PushAdapter {
  send(args: PushAdapterSendArgs): Promise<PushAdapterSendResult>
}

export interface CreatePushWorkerOptions {
  repository: PushRepository
  resolveRecipient: ResolveRecipient
  adapter: PushAdapter
  vapid: { publicKey: string; privateKey: string; subject: string }
  vapidKeyId?: string
  now?: () => Date
  createLeaseId?: () => string
  random?: () => number
  leaseMs?: number
  fetchTimeoutMs?: number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  intervalMs?: number
  stopTimeoutMs?: number
  logger?: Pick<Console, 'error' | 'warn'>
}

export type DeliverOneResult = 'idle' | 'delivered' | 'suppressed' | 'retry' | 'permanent'

export interface PushWorker {
  deliverOne(): Promise<DeliverOneResult>
  reconcile(existingUserIds: ReadonlySet<string>): Promise<number>
  start(): void
  stop(): Promise<void>
}

const GENERIC_PUSH_TEXT = 'У вас новое уведомление'

export function createPushWorker(options: CreatePushWorkerOptions): PushWorker {
  const now = options.now ?? (() => new Date())
  const createLeaseId = options.createLeaseId ?? (() => crypto.randomUUID())
  const random = options.random ?? Math.random
  const leaseMs = options.leaseMs ?? 30_000
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000
  const maxAttempts = options.maxAttempts ?? 8
  const baseDelayMs = options.baseDelayMs ?? 1_000
  const maxDelayMs = options.maxDelayMs ?? 6 * 60 * 60_000
  const intervalMs = options.intervalMs ?? 1_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000
  const logger = options.logger ?? console

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true
  let inFlight: Promise<unknown> | null = null

  async function retryOrPermanent(
    deliveryId: string, leaseId: string, attempts: number,
    lastStatus: number | null, lastError: string, delayMs: number,
  ): Promise<'retry' | 'permanent'> {
    if (attempts >= maxAttempts) {
      if (!await options.repository.markPermanent(deliveryId, leaseId, attempts, lastStatus, lastError)) {
        logger.warn('[Glocke push worker] Stale permanent settlement', { deliveryId, leaseId })
      }
      return 'permanent'
    }
    const nextAttemptAt = new Date(now().getTime() + delayMs).toISOString()
    if (!await options.repository.markRetry(deliveryId, leaseId, attempts, nextAttemptAt, lastStatus, lastError)) {
      logger.warn('[Glocke push worker] Stale retry settlement', { deliveryId, leaseId })
    }
    return 'retry'
  }

  return {
    async deliverOne() {
      const claimedAt = now()
      const leaseId = createLeaseId()
      const delivery = await options.repository.claimPendingDelivery(
        claimedAt.toISOString(),
        new Date(claimedAt.getTime() + leaseMs).toISOString(),
        leaseId,
      )
      if (!delivery) return 'idle'

      const subscription = await options.repository.findSubscriptionById(delivery.subscriptionId)
      if (!subscription) {
        if (!await options.repository.markSuppressed(delivery.id, leaseId)) {
          logger.warn('[Glocke push worker] Stale missing-subscription settlement', { deliveryId: delivery.id, leaseId })
        }
        return 'suppressed'
      }

      if (
        (subscription.expirationTime && Date.parse(subscription.expirationTime) <= claimedAt.getTime()) ||
        (options.vapidKeyId && subscription.vapidKeyId !== options.vapidKeyId)
      ) {
        await options.repository.deleteSubscription(delivery.userId, delivery.subscriptionId)
        return 'permanent'
      }

      let recipient: Awaited<ReturnType<ResolveRecipient>>
      try {
        recipient = await options.resolveRecipient(delivery.userId)
      } catch (error) {
        logger.error('[Glocke push worker] Recipient resolution failed', error)
        const delayMs = calculateBackoffDelay({ attempt: delivery.attempts, baseDelayMs, maxDelayMs, random })
        return retryOrPermanent(delivery.id, leaseId, delivery.attempts + 1, null, 'Recipient lookup failed', delayMs)
      }
      if (!recipient?.notifyBrowserPush) {
        if (!await options.repository.markSuppressed(delivery.id, leaseId)) {
          logger.warn('[Glocke push worker] Stale suppression settlement', { deliveryId: delivery.id, leaseId })
        }
        return 'suppressed'
      }

      let result: PushAdapterSendResult
      try {
        result = await options.adapter.send({
          subscription: { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
          payload: { id: delivery.id, text: GENERIC_PUSH_TEXT, url: delivery.destinationUrl },
          vapid: options.vapid,
          timeoutMs: fetchTimeoutMs,
        })
      } catch (error) {
        logger.error('[Glocke push worker] Push adapter threw unexpectedly', error)
        const delayMs = calculateBackoffDelay({ attempt: delivery.attempts, baseDelayMs, maxDelayMs, random })
        return retryOrPermanent(delivery.id, leaseId, delivery.attempts + 1, null, 'Push adapter failed', delayMs)
      }

      if (result.outcome === 'sent' && (result.status === 404 || result.status === 410)) {
        await options.repository.deleteSubscription(delivery.userId, delivery.subscriptionId)
        return 'permanent'
      }

      if (result.outcome === 'sent') {
        const classification = classifyNotificationResponse(result.status)
        if (classification === 'success') {
          const deliveredAt = now().toISOString()
          if (!await options.repository.markDelivered(delivery.id, leaseId, deliveredAt)) {
            logger.warn('[Glocke push worker] Stale delivered settlement', { deliveryId: delivery.id, leaseId })
            return 'delivered'
          }
          try {
            await options.repository.touchSubscriptionSuccess(subscription.id, deliveredAt)
          } catch (error) {
            logger.error('[Glocke push worker] Subscription success timestamp failed', error)
          }
          return 'delivered'
        }
        if (classification === 'permanent') {
          if (!await options.repository.markPermanent(delivery.id, leaseId, delivery.attempts + 1, result.status, `HTTP ${result.status}`)) {
            logger.warn('[Glocke push worker] Stale HTTP settlement', { deliveryId: delivery.id, leaseId })
          }
          return 'permanent'
        }
        const delayMs = result.retryAfterMs !== undefined
          ? Math.min(result.retryAfterMs, maxDelayMs)
          : calculateBackoffDelay({ attempt: delivery.attempts, baseDelayMs, maxDelayMs, random })
        return retryOrPermanent(delivery.id, leaseId, delivery.attempts + 1, result.status, `HTTP ${result.status}`, delayMs)
      }

      if (result.outcome === 'timeout') {
        const delayMs = calculateBackoffDelay({ attempt: delivery.attempts, baseDelayMs, maxDelayMs, random })
        return retryOrPermanent(delivery.id, leaseId, delivery.attempts + 1, null, 'Request timed out', delayMs)
      }

      const delayMs = calculateBackoffDelay({ attempt: delivery.attempts, baseDelayMs, maxDelayMs, random })
      return retryOrPermanent(delivery.id, leaseId, delivery.attempts + 1, null, 'Network error', delayMs)
    },

    async reconcile(existingUserIds) {
      return options.repository.deleteOrphanedSubscriptions(existingUserIds)
    },

    start() {
      stopped = false
      const tick = () => {
        if (stopped) return
        inFlight = this.deliverOne().catch((error) => {
          logger.error('[Glocke push worker] Delivery failed unexpectedly', error)
          return 'idle' as const
        }).finally(() => {
          if (!stopped) timer = setTimeout(tick, intervalMs)
        })
      }
      timer = setTimeout(tick, intervalMs)
    },

    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (inFlight) {
        await Promise.race([
          inFlight,
          new Promise((resolve) => setTimeout(resolve, stopTimeoutMs)),
        ])
      }
    },
  }
}
