import { notificationEventEnvelopeSchema } from '@zudar107/schloss-server-kit'
import type {
  EventEnvelope, EventPayload, NotificationRecord, NotificationRepository, PushDeliveryRecord, ResolveRecipient,
} from './contracts.js'
import type { SourceOrigins } from './config.js'
import { eventRegistryByType } from './event-registry.js'

export interface Processor {
  processNext(): Promise<'processed' | 'idle'>
}

export interface CreateProcessorOptions {
  repository: NotificationRepository
  resolveRecipient: ResolveRecipient
  now?: () => Date
  createId?: () => string
  createPushDeliveryId?: () => string
  createLeaseId?: () => string
  leaseMs?: number
  sourceOrigins?: Readonly<SourceOrigins>
  glockeOrigin?: string
}

export function createProcessor(options: CreateProcessorOptions): Processor {
  const now = options.now ?? (() => new Date())
  const createId = options.createId ?? (() => crypto.randomUUID())
  const createPushDeliveryId = options.createPushDeliveryId ?? (() => crypto.randomUUID())
  const createLeaseId = options.createLeaseId ?? (() => crypto.randomUUID())
  const leaseMs = options.leaseMs ?? 30_000

  return {
    async processNext() {
      const claimedAt = now()
      const leaseId = createLeaseId()
      const event = await options.repository.claimPendingInbox(
        claimedAt.toISOString(),
        new Date(claimedAt.getTime() + leaseMs).toISOString(),
        leaseId,
      )
      if (!event) return 'idle'

      const envelope = parsePersistedEnvelope(event)
      if (!envelope) {
        const processedAt = now().toISOString()
        return await options.repository.markInboxProcessed(
          event.source, event.eventId, leaseId, processedAt,
        ) ? 'processed' : 'idle'
      }

      const recipient = await options.resolveRecipient(event.userId)
      if (recipient?.notifyInApp || recipient?.notifyBrowserPush) {
        const materializedAt = now().toISOString()
        const payload = renderNotification(envelope, options.sourceOrigins)
        const notification: NotificationRecord | null = recipient.notifyInApp ? {
          id: createId(),
          eventId: event.eventId,
          userId: event.userId,
          source: event.source,
          type: envelope.type,
          ...payload,
          createdAt: envelope.occurredAt,
          readAt: null,
        } : null

        let pushDeliveries: PushDeliveryRecord[] = []
        if (recipient.notifyBrowserPush) {
          const destinationUrl = resolveDestinationUrl(payload.actionUrl, options.glockeOrigin)
          const subscriptions = await options.repository.listActiveSubscriptions(event.userId)
          pushDeliveries = subscriptions.map((subscription) => ({
            id: createPushDeliveryId(),
            eventId: event.eventId,
            source: event.source,
            userId: event.userId,
            subscriptionId: subscription.id,
            destinationUrl,
            state: 'pending' as const,
            attempts: 0,
            nextAttemptAt: null,
            leaseId: null,
            leaseUntil: null,
            deliveredAt: null,
            lastStatus: null,
          lastError: null,
          settledAt: null,
          }))
        }

        const result = await options.repository.materializeNotification({
          source: event.source,
          eventId: event.eventId,
          leaseId,
          now: materializedAt,
          notification,
          pushDeliveries,
        })
        if (result === 'stale') return 'idle'
      }
      const processedAt = now().toISOString()
      return await options.repository.markInboxProcessed(
        event.source, event.eventId, leaseId, processedAt,
      ) ? 'processed' : 'idle'
    },
  }
}

function resolveDestinationUrl(actionUrl: string | null, glockeOrigin: string | undefined): string {
  const origin = glockeOrigin ?? 'http://localhost'
  if (!actionUrl) return `${origin}/notifications`
  try {
    return new URL(actionUrl).toString()
  } catch {
    return new URL(actionUrl, origin).toString()
  }
}

function parsePersistedEnvelope(event: import('./contracts.js').InboxRecord): EventEnvelope | null {
  const envelope = notificationEventEnvelopeSchema.safeParse(event.envelope)
  if (!envelope.success || envelope.data.id !== event.eventId || envelope.data.source !== event.source) return null

  const registered = eventRegistryByType.get(envelope.data.type)
  if (!registered || registered.source !== envelope.data.source) return null

  // Old accepted rows may contain presentation fields. Ignore only those known
  // fields, then apply the current strict payload contract before rendering.
  if (!envelope.data.payload || typeof envelope.data.payload !== 'object' || Array.isArray(envelope.data.payload)) return null
  const { title: _title, body: _body, actionUrl: _actionUrl, ...payload } = envelope.data.payload as Record<string, unknown>
  const parsedPayload = registered.payloadSchema.safeParse(payload)
  if (!parsedPayload.success) return null
  const validatedPayload = parsedPayload.data as EventPayload
  if (validatedPayload.recipientId !== event.userId) return null

  return { ...envelope.data, payload: validatedPayload } as EventEnvelope
}

function renderNotification(
  envelope: EventEnvelope,
  sourceOrigins?: Readonly<SourceOrigins>,
): Pick<NotificationRecord, 'title' | 'body' | 'actionUrl'> {
  const registered = eventRegistryByType.get(envelope.type)
  if (!registered) throw new Error(`Unsupported notification event type: ${envelope.type}`)
  const rendered = registered.render(envelope.payload)
  const sourceOrigin = envelope.source === 'kuvert'
    ? sourceOrigins?.kuvert
    : envelope.source === 'tafel' ? sourceOrigins?.tafel : undefined
  return sourceOrigin && rendered.actionUrl
    ? { ...rendered, actionUrl: new URL(rendered.actionUrl, sourceOrigin).toString() }
    : rendered
}
