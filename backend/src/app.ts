import { createHash } from 'node:crypto'
import {
  exportEnvelopeSchema,
  notificationEventEnvelopeSchema,
  verifyNotificationRequest,
  type AuthUser,
  type ExportAuthEnv,
} from '@zudar107/schloss-server-kit'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { Authenticate, EventEnvelope, NotificationRepository, ResolveRecipient } from './contracts.js'
import { eventRegistryByType } from './event-registry.js'
import type { PushRepository } from './push-repository.js'
import { validatePushSubscriptionInput } from './push-validation.js'

export interface PushApiConfig {
  available: boolean
  vapidPublicKey: string | null
  vapidKeyId: string | null
  allowedProviderHosts: readonly string[]
  maxSubscriptionsPerUser: number
}

const strictNotificationEventEnvelopeSchema = notificationEventEnvelopeSchema.strict()

export interface ProducerCredential {
  keyId: string
  secret: string
}

export interface CreateAppOptions {
  repository: NotificationRepository
  sourceCredentials?: Readonly<Record<string, ProducerCredential>>
  /** @deprecated Test compatibility; production uses sourceCredentials. */
  sourceSecrets?: Readonly<Record<string, string>>
  authenticate?: Authenticate
  requireAuth?: MiddlewareHandler
  requireAdmin?: MiddlewareHandler
  requireExportAuth?: MiddlewareHandler<ExportAuthEnv>
  maxSkewSeconds?: number
  maxEventBytes?: number
  now?: () => Date
  ready?: () => Promise<boolean>
  pushRepository?: PushRepository
  resolveRecipient?: ResolveRecipient
  pushConfig?: PushApiConfig
  createPushSubscriptionId?: () => string
  getSessionId?: (request: Request) => string | null
}

const endpointHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const pushCleanupPayloadSchema = z.object({ recipientId: z.string().min(1), sessionId: z.string().min(1).max(128) }).strict()

function accessTokenSessionId(request: Request): string | null {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!token) return null
  try {
    const encoded = token.split('.')[1]
    if (!encoded) return null
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Record<string, unknown>
    return typeof payload['sid'] === 'string' && payload['sid'].length > 0 && payload['sid'].length <= 128
      ? payload['sid']
      : null
  } catch {
    return null
  }
}

function credentials(options: CreateAppOptions): Readonly<Record<string, ProducerCredential>> {
  if (options.sourceCredentials) return options.sourceCredentials
  return Object.fromEntries(Object.entries(options.sourceSecrets ?? {}).map(([source, secret]) => [
    source,
    { keyId: `${source}-test`, secret },
  ]))
}

function testAuth(options: CreateAppOptions): MiddlewareHandler {
  return async (context, next) => {
    const userId = await options.authenticate?.(context.req.raw)
    if (!userId) return context.json({ error: 'Unauthorized' }, 401)
    context.set('user', {
      id: userId,
      email: `${userId}@test.invalid`,
      name: userId,
      role: 'user',
      weekStart: null,
      dateFormat: null,
      timezone: null,
    } satisfies AuthUser)
    await next()
  }
}

function testExportAuth(options: CreateAppOptions): MiddlewareHandler<ExportAuthEnv> {
  return async (context, next) => {
    const userId = await options.authenticate?.(context.req.raw)
    if (!userId) return context.json({ error: 'Unauthorized' }, 401)
    context.set('exportPrincipal', { sub: userId, kind: 'access' })
    await next()
  }
}

export function createApp(options: CreateAppOptions): Hono<ExportAuthEnv> {
  const app = new Hono<ExportAuthEnv>()
  const producers = credentials(options)
  const requireAuth = options.requireAuth ?? testAuth(options)
  const requireAdmin = options.requireAdmin ?? (async (_context, next) => next())
  const requireExportAuth = options.requireExportAuth ?? testExportAuth(options)
  const now = options.now ?? (() => new Date())

  app.get('/health', (context) => context.json({ status: 'ok', service: 'Glocke' }))
  app.get('/ready', async (context) => {
    const ready = await (options.ready?.() ?? Promise.resolve(true))
    return ready
      ? context.json({ status: 'ready', service: 'Glocke' })
      : context.json({ status: 'unavailable', service: 'Glocke' }, 503)
  })

  app.post('/internal/v1/events', async (context) => {
    const contentLength = Number(context.req.header('Content-Length'))
    const maxBytes = options.maxEventBytes ?? 64 * 1024
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return context.json({ error: 'Request body too large' }, 413)
    }

    const rawBytes = new Uint8Array(await context.req.raw.arrayBuffer())
    if (rawBytes.byteLength > maxBytes) return context.json({ error: 'Request body too large' }, 413)
    const rawBody = new TextDecoder().decode(rawBytes)
    const source = context.req.header('X-Hof-Service') ?? ''
    if (
      !source ||
      !context.req.header('X-Hof-Key-Id') ||
      !context.req.header('X-Hof-Timestamp') ||
      !context.req.header('X-Hof-Signature')
    ) return context.json({ error: 'Missing signature' }, 401)
    const producer = Object.hasOwn(producers, source) ? producers[source] : undefined
    if (!producer) return context.json({ error: 'Producer is not configured' }, 403)

    const timestamp = Number(context.req.header('X-Hof-Timestamp'))
    const requestUrl = new URL(context.req.url)
    const validSignature = verifyNotificationRequest({
      secret: producer.secret,
      keyId: context.req.header('X-Hof-Key-Id') ?? '',
      source,
      timestamp,
      method: context.req.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      rawBody: rawBytes,
      signature: context.req.header('X-Hof-Signature') ?? '',
      expectedKeyId: producer.keyId,
      expectedSource: source,
      maxSkewSeconds: options.maxSkewSeconds ?? 300,
      now: () => now().getTime(),
    })
    if (!validSignature) return context.json({ error: 'Invalid signature' }, 401)

    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return context.json({ error: 'Invalid JSON' }, 400)
    }
    const parsed = strictNotificationEventEnvelopeSchema.safeParse(json)
    if (!parsed.success || parsed.data.source !== source) {
      return context.json({ error: 'Invalid event envelope' }, 400)
    }

    if (parsed.data.source === 'schlussel' && parsed.data.type === 'schlussel.push.session_revoked.v1') {
      const cleanup = pushCleanupPayloadSchema.safeParse(parsed.data.payload)
      if (!cleanup.success || !options.pushRepository) return context.json({ error: 'Invalid push cleanup' }, 400)
      await options.pushRepository.deleteSubscriptionsForSession(cleanup.data.recipientId, cleanup.data.sessionId)
      return context.json({ status: 'accepted' }, 202)
    }

    // Registry is the sole authority on which (source, type) pairs exist
    // and what shape their payload takes - a source claiming a type it
    // doesn't own, or a type this deployment never registered, is
    // rejected here regardless of whether the payload itself looks
    // otherwise valid.
    const registered = eventRegistryByType.get(parsed.data.type)
    if (!registered || registered.source !== parsed.data.source) {
      return context.json({ error: 'Invalid event envelope' }, 400)
    }
    const payload = registered.payloadSchema.safeParse(parsed.data.payload)
    if (!payload.success) {
      return context.json({ error: 'Invalid event envelope' }, 400)
    }

    const envelope = { ...parsed.data, payload: payload.data } as EventEnvelope

    const acceptedAt = now().toISOString()
    const result = await options.repository.acceptInbox({
      eventId: envelope.id,
      source: envelope.source,
      userId: envelope.payload.recipientId,
      payloadHash: createHash('sha256').update(rawBytes).digest('hex'),
      envelope,
      status: 'pending',
      acceptedAt,
      processedAt: null,
      leaseUntil: null,
      leaseId: null,
    })
    if (result === 'conflict') return context.json({ error: 'Event identity conflict' }, 409)
    if (result === 'duplicate') return context.json({ status: 'duplicate' })
    return context.json({ status: 'accepted' }, 202)
  })

  const pushPrivateResponse: MiddlewareHandler = async (context, next) => {
    context.header('Cache-Control', 'private, no-store, no-cache')
    context.header('X-Content-Type-Options', 'nosniff')
    await next()
  }
  app.use('/notifications/push/*', pushPrivateResponse)

  app.use('/notifications', requireAuth)
  app.use('/notifications/*', requireAuth)

  app.get('/notifications', async (context) => {
    const parsedLimit = z.coerce.number().int().min(1).max(100).safeParse(context.req.query('limit') ?? 25)
    if (!parsedLimit.success) return context.json({ error: 'limit must be an integer between 1 and 100' }, 400)
    return context.json(await options.repository.listNotifications(
      context.get('user').id,
      context.req.query('cursor') ?? null,
      parsedLimit.data,
    ))
  })
  app.get('/notifications/unread-count', async (context) => context.json({
    count: await options.repository.unreadCount(context.get('user').id),
  }))
  app.post('/notifications/read-all', async (context) => context.json({
    updated: await options.repository.markAllRead(context.get('user').id, now().toISOString()),
  }))
  app.post('/notifications/:id/read', async (context) => {
    const notification = await options.repository.markRead(
      context.get('user').id,
      context.req.param('id'),
      now().toISOString(),
    )
    return notification ? context.json(notification) : context.json({ error: 'Not found' }, 404)
  })
  app.delete('/notifications/:id', async (context) => {
    const deleted = await options.repository.deleteNotification(context.get('user').id, context.req.param('id'))
    return deleted ? context.body(null, 204) : context.json({ error: 'Not found' }, 404)
  })
  app.delete('/notifications', async (context) => context.json({
    deleted: await options.repository.deleteAllNotifications(context.get('user').id),
  }))

  const createPushSubscriptionId = options.createPushSubscriptionId ?? (() => crypto.randomUUID())

  app.get('/notifications/push/status', async (context) => {
    const userId = context.get('user').id
    const pushConfig = options.pushConfig
    const recipient = await options.resolveRecipient?.(userId)
    const sessionId = options.getSessionId
      ? options.getSessionId(context.req.raw)
      : options.authenticate ? 'test-session' : accessTokenSessionId(context.req.raw)
    const parsedHash = endpointHashSchema.safeParse(context.req.query('endpointHash'))
    const subscriptions = await options.pushRepository?.listSubscriptions(userId) ?? []
    const currentSubscription = parsedHash.success && sessionId
      ? subscriptions.find((subscription) => (
          subscription.sessionId === sessionId && subscription.endpointHash === parsedHash.data
        )) ?? null
      : null
    return context.json({
      available: pushConfig?.available ?? false,
      notifyBrowserPush: recipient?.notifyBrowserPush ?? false,
      vapidPublicKey: pushConfig?.vapidPublicKey ?? null,
      vapidKeyId: pushConfig?.vapidKeyId ?? null,
      currentSubscription: currentSubscription ? {
        id: currentSubscription.id,
        providerHost: currentSubscription.providerHost,
        createdAt: currentSubscription.createdAt,
        lastSuccessAt: currentSubscription.lastSuccessAt,
      } : null,
    })
  })

  app.put('/notifications/push/subscriptions', async (context) => {
    const pushConfig = options.pushConfig
    if (!options.pushRepository || !pushConfig) return context.json({ error: 'Browser push is not available' }, 503)

    let rawBody: unknown
    try {
      rawBody = await context.req.json()
    } catch {
      return context.json({ error: 'Invalid JSON' }, 400)
    }
    // Owner is always the verified JWT subject - strip any owner/identity
    // shaped field the caller might have included before strict-validating
    // the rest of the body, rather than rejecting the whole request for it.
    const candidate = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? Object.fromEntries(Object.entries(rawBody).filter(([key]) => key !== 'userId' && key !== 'id'))
      : rawBody
    const validated = validatePushSubscriptionInput(candidate, pushConfig.allowedProviderHosts, now())
    if (!validated.valid) return context.json({ error: `Invalid push subscription: ${validated.reason}` }, 400)

    const userId = context.get('user').id
    const sessionId = options.getSessionId
      ? options.getSessionId(context.req.raw)
      : options.authenticate ? 'test-session' : accessTokenSessionId(context.req.raw)
    if (!sessionId) return context.json({ error: 'A session-bound access token is required' }, 409)
    const at = now().toISOString()
    const result = await options.pushRepository.putSubscription({
      id: createPushSubscriptionId(),
      userId,
      sessionId,
      endpoint: validated.endpoint,
      endpointHash: createHash('sha256').update(validated.endpoint).digest('hex'),
      p256dh: validated.p256dh,
      auth: validated.auth,
      expirationTime: validated.expirationTime ? new Date(validated.expirationTime).toISOString() : null,
      providerHost: validated.providerHost,
      vapidKeyId: pushConfig.vapidKeyId ?? '',
      createdAt: at,
      updatedAt: at,
      lastSuccessAt: null,
    }, pushConfig.maxSubscriptionsPerUser)

    if (result === 'conflict' || result === 'limit-exceeded') {
      return context.json({ error: result === 'conflict' ? 'Endpoint already registered to another account' : 'Subscription limit exceeded' }, 409)
    }
    // putSubscription only reports created/updated as a bare status, not
    // the persisted row - on an update, the existing row's own id/
    // createdAt/lastSuccessAt are kept as-is (see push-repository.ts),
    // not the freshly generated ones just sent above, so re-read the
    // real row rather than echoing back what was sent. The frontend
    // stores this response directly as a PushSubscriptionSummary
    // (BrowserPushSettings.tsx) - returning just {status} left it with
    // no id/providerHost/createdAt to render or to target a later delete.
    const persisted = await options.pushRepository.findSubscriptionByEndpoint(validated.endpoint)
    if (!persisted) return context.json({ error: 'Subscription not found after write' }, 500)
    return context.json({
      id: persisted.id,
      providerHost: persisted.providerHost,
      createdAt: persisted.createdAt,
      lastSuccessAt: persisted.lastSuccessAt,
    })
  })

  app.delete('/notifications/push/subscriptions/:id', async (context) => {
    if (!options.pushRepository) return context.json({ error: 'Browser push is not available' }, 503)
    const userId = context.get('user').id
    const sessionId = options.getSessionId
      ? options.getSessionId(context.req.raw)
      : options.authenticate ? 'test-session' : accessTokenSessionId(context.req.raw)
    const endpointHash = endpointHashSchema.safeParse(context.req.query('endpointHash'))
    if (!sessionId || !endpointHash.success) return context.json({ error: 'Current browser correlation is required' }, 400)
    const id = context.req.param('id')
    const subscription = await options.pushRepository.findSubscriptionById(id)
    if (subscription && (
      subscription.userId !== userId || subscription.sessionId !== sessionId || subscription.endpointHash !== endpointHash.data
    )) return context.json({ error: 'Not found' }, 404)
    if (subscription) await options.pushRepository.deleteBoundSubscription(userId, sessionId, id, endpointHash.data)
    return context.body(null, 204)
  })

  app.get('/exports/me', async (context, next) => {
    context.header('Cache-Control', 'private, no-store')
    context.header('Pragma', 'no-cache')
    context.header('X-Content-Type-Options', 'nosniff')
    await next()
  }, requireExportAuth, async (context) => {
    const principal = context.get('exportPrincipal')
    if (!principal) return context.json({ error: 'Unauthorized' }, 401)

    const notifications = (await options.repository.exportNotifications(principal.sub)).map((notification) => ({
      id: notification.id,
      eventId: notification.eventId,
      source: notification.source,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      actionUrl: notification.actionUrl,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
    }))

    return context.json(exportEnvelopeSchema.parse({
      version: '1',
      service: 'glocke',
      exportedAt: now().toISOString(),
      data: { notifications },
    }))
  })

  app.get('/openapi.json', requireAuth, requireAdmin, async (context) => {
    const { openApiDocument } = await import('./openapi.js')
    return context.json(openApiDocument)
  })

  return app
}
