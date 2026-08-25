import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { eventRegistry } from './event-registry.js'

const registry = new OpenAPIRegistry()
registry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
registry.registerComponent('securitySchemes', 'exportDelegationAuth', {
  type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
  description: 'Schlüssel export delegation for Glocke with token_use=export, data:export scope, and hof-service:glocke audience.',
})
registry.registerComponent('securitySchemes', 'hofHmac', {
  type: 'apiKey', in: 'header', name: 'X-Hof-Signature',
  description: '64-character hexadecimal HMAC-SHA-256 over timestamp, uppercase method, path with query, SHA-256 of the exact body bytes, key id, and source (newline-delimited). The shared signer emits lowercase; verification is case-insensitive. Also requires X-Hof-Service, X-Hof-Key-Id, and X-Hof-Timestamp.',
})

const bearer = [{ bearerAuth: [] }]
const notification = z.object({
  id: z.string(), eventId: z.string(), source: z.string(), type: z.string(), title: z.string(), body: z.string(),
  actionUrl: z.string().nullable(), createdAt: z.iso.datetime(), readAt: z.iso.datetime().nullable(),
}).strict()
const exportResponse = z.object({
  version: z.literal('1'),
  service: z.literal('glocke'),
  exportedAt: z.iso.datetime(),
  data: z.object({ notifications: z.array(notification) }).strict(),
}).strict()
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } })
const endpointHash = z.string().regex(/^[0-9a-f]{64}$/).describe('SHA-256 hex digest of the current local PushSubscription endpoint')
const pushSummary = z.object({
  id: z.string(), providerHost: z.string(), createdAt: z.iso.datetime(), lastSuccessAt: z.iso.datetime().nullable(),
}).strict()
const pushStatus = z.object({
  available: z.boolean(),
  notifyBrowserPush: z.boolean(),
  vapidPublicKey: z.string().nullable(),
  vapidKeyId: z.string().nullable(),
  currentSubscription: pushSummary.nullable(),
}).strict()
const pushSubscriptionInput = z.object({
  endpoint: z.url(),
  expirationTime: z.number().int().positive().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }).strict(),
}).strict()

registry.registerPath({
  method: 'get', path: '/notifications', tags: ['notifications'], summary: 'List caller-owned notifications', security: bearer,
  description: 'Returns only notifications owned by the subject of the verified JWT, newest first. The cursor is opaque.',
  request: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
  responses: { 200: { description: 'Newest first', ...json(z.object({ items: z.array(notification), nextCursor: z.string().nullable() })) } },
})
registry.registerPath({
  method: 'get', path: '/notifications/push/status', tags: ['push'], summary: 'Get current-browser Push status', security: bearer,
  description: 'Correlates only the verified session and the browser-supplied SHA-256 endpoint digest. It never returns endpoints or encryption keys and never selects an arbitrary account subscription.',
  request: { query: z.object({ endpointHash: endpointHash.optional() }) },
  responses: { 200: { description: 'Session- and browser-scoped status', ...json(pushStatus) } },
})
registry.registerPath({
  method: 'put', path: '/notifications/push/subscriptions', tags: ['push'], summary: 'Register the current browser', security: bearer,
  description: 'Requires a session-backed access token with sid. Ownership and session identity come only from the verified token.',
  request: { body: { content: { 'application/json': { schema: pushSubscriptionInput } } } },
  responses: {
    200: { description: 'Created or refreshed current-browser subscription', ...json(pushSummary) },
    400: { description: 'Invalid subscription or expiration' },
    409: { description: 'Legacy token, endpoint ownership conflict, or subscription limit' },
  },
})
registry.registerPath({
  method: 'delete', path: '/notifications/push/subscriptions/{id}', tags: ['push'], summary: 'Delete the current browser subscription', security: bearer,
  description: 'Deletes only when subject, sid, subscription ID, and local endpoint hash all match.',
  request: { params: z.object({ id: z.string() }), query: z.object({ endpointHash }) },
  responses: { 204: { description: 'Deleted or already absent' }, 400: { description: 'Missing browser correlation' }, 404: { description: 'Not owned by this user, session, and browser' } },
})
registry.registerPath({
  method: 'get', path: '/notifications/unread-count', tags: ['notifications'], summary: 'Get unread count', security: bearer,
  responses: { 200: { description: 'Unread count', ...json(z.object({ count: z.number().int().nonnegative() })) } },
})
registry.registerPath({
  method: 'post', path: '/notifications/{id}/read', tags: ['notifications'], summary: 'Mark one notification read', security: bearer,
  request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'Notification', ...json(notification) }, 404: { description: 'Not found' } },
})
registry.registerPath({
  method: 'post', path: '/notifications/read-all', tags: ['notifications'], summary: 'Mark all notifications read', security: bearer,
  responses: { 200: { description: 'Updated count', ...json(z.object({ updated: z.number().int().nonnegative() })) } },
})
registry.registerPath({
  method: 'delete', path: '/notifications/{id}', tags: ['notifications'], summary: 'Delete one notification', security: bearer,
  request: { params: z.object({ id: z.string() }) }, responses: { 204: { description: 'Deleted' }, 404: { description: 'Not found' } },
})
registry.registerPath({
  method: 'delete', path: '/notifications', tags: ['notifications'], summary: 'Delete all caller-owned notifications', security: bearer,
  responses: { 200: { description: 'Deleted count', ...json(z.object({ deleted: z.number().int().nonnegative() })) } },
})
registry.registerPath({
  method: 'get', path: '/exports/me', tags: ['exports'], summary: 'Export caller-owned Glocke data',
  description: 'Synchronous direct Glocke JSON endpoint used by Settings and as an input to Schlüssel\'s separate asynchronous ZIP collector. Contains every subject-owned user-visible notification and read state without pagination, read when this request runs; it is not a cross-service point-in-time snapshot. Accepts an access token or a JWKS-verified delegation with the exact issuer, token_use=export, single hof-service:glocke audience, data:export scope, nonempty subject/job/token IDs, and a non-expired numeric expiry. Delegations are rejected by ordinary routes and the subject comes only from the verified principal. Inbox envelopes/hashes, suppressed events, worker leases, local user rows, credentials, runtime configuration, logs, other users, and other services are excluded. The response is private, no-store, and nosniff.',
  security: [{ bearerAuth: [] }, { exportDelegationAuth: [] }],
  responses: {
    200: { description: 'Versioned Glocke export envelope', ...json(exportResponse) },
    401: { description: 'Missing, invalid, expired, or incorrectly scoped token' },
  },
})
const eventEnvelopeVariants = [...eventRegistry.map((registered) => z.object({
  version: z.literal('1'),
  id: z.uuid().describe('Non-nil event UUID'),
  type: z.literal(registered.type),
  source: z.literal(registered.source),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid().describe('Non-nil correlation UUID'),
  payload: registered.payloadSchema,
}).strict().describe(`Exact payload contract for ${registered.type}; only source ${registered.source} may send it. Presentation (title/body/actionUrl) is never producer-supplied - Glocke renders it centrally.`)), z.object({
  version: z.literal('1'), id: z.uuid(), type: z.literal('schlussel.push.session_revoked.v1'), source: z.literal('schlussel'),
  occurredAt: z.iso.datetime(), correlationId: z.uuid(),
  payload: z.object({ recipientId: z.string().min(1), sessionId: z.string().min(1).max(128) }).strict(),
}).strict().describe('Durably produced Schlüssel cleanup for one exact user session.')] as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]

registry.registerPath({
  method: 'post', path: '/internal/v1/events', tags: ['internal'], summary: 'Accept a signed notification event',
  description: 'Authenticates the exact request body bytes and configured producer identity before durably writing the inbox. The envelope must match one of the registered (source, type) contracts exactly - an unregistered type, a type claimed by the wrong source, a whitespace-only identifier/text value, or a payload with unexpected/missing fields is rejected. Glocke renders presentation centrally; Kuvert and Tafel actions use trusted configured HTTPS origins. A new event returns 202, an exact byte-for-byte replay of the same source and event id returns 200, and identity reuse with different bytes returns 409. Producers may retry with the same stable event id; this is idempotent intake, not an exactly-once delivery guarantee.',
  security: [{ hofHmac: [] }],
  request: { body: { content: { 'application/json': { schema: z.union(eventEnvelopeVariants) } } } },
  responses: {
    202: { description: 'Durably accepted as a new inbox event' },
    200: { description: 'Exact duplicate; no second inbox row was created' },
    400: { description: 'Invalid JSON, envelope, source/type relationship, or payload' },
    401: { description: 'Missing, malformed, stale, or invalid signature' },
    403: { description: 'Source producer is not configured' },
    409: { description: 'The source and event id already exist with different exact body bytes' },
    413: { description: 'Request body exceeds the configured event limit' },
  },
})

export const openApiDocument = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: '3.0.0',
  info: { title: 'Glocke API', version: '0.1.0', description: 'Durable, account-scoped Hof in-app notification center with authenticated, idempotent event intake. It does not claim exactly-once delivery.' },
  servers: [{ url: '/backend' }],
})
