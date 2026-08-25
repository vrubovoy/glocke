import { beforeEach, describe, expect, it } from 'vitest'
import { signNotificationRequest } from '@zudar107/schloss-server-kit'
import { createApp } from '../app.js'
import { createHttpApp } from '../http.js'
import { pushSubscriptionRecord, pushSubscriptionRequestBody, VAPID } from './helpers/push-fixtures.js'
import { MemoryPushRepository } from './helpers/push-repository.js'
import { MemoryNotificationRepository } from './helpers/repository.js'

// CONTRACT: backend/src/app.ts's createApp(options) gains three new
// authenticated (session JWT, same `requireAuth`/testAuth already used by
// /notifications/*) routes and three new options:
//
//   pushRepository: PushRepository        // backend/src/push-repository.ts
//   resolveRecipient: ResolveRecipient     // contracts.ts - already exists as a type,
//                                          // not previously passed to createApp (only to
//                                          // the processor); app.ts needs it too now for
//                                          // GET /status's `notifyBrowserPush` field
//   pushConfig: {
//     available: boolean
//     vapidPublicKey: string | null
//     vapidKeyId: string | null
//     allowedProviderHosts: readonly string[]
//     maxSubscriptionsPerUser: number
//   }
//
//   GET    /notifications/push/status
//     -> { available, notifyBrowserPush, vapidPublicKey, vapidKeyId,
//          subscriptions: [{ id, providerHost, createdAt, lastSuccessAt }] }
//     NEVER endpoint/p256dh/auth.
//   PUT    /notifications/push/subscriptions
//     -> body validated via push-validation.ts's validatePushSubscriptionInput
//        against pushConfig.allowedProviderHosts; owner is the verified JWT
//        subject, any owner-shaped field in the body is ignored. 200 on
//        create-or-update with body { id, providerHost, createdAt,
//        lastSuccessAt } - the SAME shape GET /status's subscriptions[]
//        entries use, since the frontend stores this response directly as
//        one. On an update (re-subscribing an already-registered
//        endpoint), this is the EXISTING row's own id/createdAt/
//        lastSuccessAt, not freshly generated ones. 400 on validation
//        failure, 409 on endpoint already owned by a different account OR
//        the per-user cap being exceeded (both are "this write cannot be
//        accepted as requested" conflicts - a distinct 4xx like 429 would
//        also be defensible, but 409 keeps both write-rejection cases in
//        the same status family).
//   DELETE /notifications/push/subscriptions/:id
//     -> owner-only; 404 (not 403) for another user's id, matching this
//        platform's existing ownership-check convention; 204 idempotently.
//   All three: `Cache-Control: private, no-store, no-cache` (note the
//   extra `no-cache` beyond the existing /notifications routes' `private,
//   no-store`) and `X-Content-Type-Options: nosniff`.

const USER_1_HEADERS = { Authorization: 'Bearer user-1-token' }
const USER_2_HEADERS = { Authorization: 'Bearer user-2-token' }
const SCHLUSSEL_SECRET = 'schlussel-test-secret-at-least-32-bytes'

const PUSH_CONFIG = {
  available: true,
  vapidPublicKey: VAPID.publicKey,
  vapidKeyId: VAPID.keyId,
  allowedProviderHosts: ['fcm.googleapis.com', 'updates.push.services.mozilla.com'],
  maxSubscriptionsPerUser: 10,
}

function expectPrivateNoCacheResponse(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, no-cache')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
}

describe('browser push APIs', () => {
  let notificationRepository: MemoryNotificationRepository
  let pushRepository: MemoryPushRepository
  let app: ReturnType<typeof createHttpApp>
  let recipients: Record<string, { notifyInApp: boolean; notifyBrowserPush: boolean }>
  let sessions: Record<string, string | undefined>

  beforeEach(() => {
    notificationRepository = new MemoryNotificationRepository()
    pushRepository = new MemoryPushRepository()
    recipients = {
      'user-1': { notifyInApp: true, notifyBrowserPush: true },
      'user-2': { notifyInApp: true, notifyBrowserPush: false },
    }
    sessions = { [USER_1_HEADERS.Authorization]: 'session-1', [USER_2_HEADERS.Authorization]: 'session-2' }
    const service = createApp({
      repository: notificationRepository,
      pushRepository,
      pushConfig: PUSH_CONFIG,
      resolveRecipient: async (userId: string) => recipients[userId] ? { userId, ...recipients[userId] } : null,
      sourceSecrets: { schlussel: SCHLUSSEL_SECRET },
      getSessionId: (request) => sessions[request.headers.get('Authorization') ?? ''] ?? null,
      authenticate: async (request) => {
        const token = request.headers.get('Authorization')
        if (token === USER_1_HEADERS.Authorization) return 'user-1'
        if (token === USER_2_HEADERS.Authorization) return 'user-2'
        return null
      },
      now: () => new Date('2026-08-07T10:00:00.000Z'),
    })
    app = createHttpApp(service, ['https://glocke.localhost'], false)
  })

  describe('GET /notifications/push/status', () => {
    it('reports availability, the current global preference, VAPID identifiers, and only the caller own subscriptions', async () => {
      pushRepository.seedSubscription(pushSubscriptionRecord({
        id: 'sub-1', userId: 'user-1', providerHost: 'fcm.googleapis.com',
        createdAt: '2026-08-01T00:00:00.000Z', lastSuccessAt: '2026-08-06T00:00:00.000Z',
      }))
      pushRepository.seedSubscription(pushSubscriptionRecord({
        id: 'sub-theirs', userId: 'user-2', endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/theirs',
      }))

      const hash = (await pushRepository.listSubscriptions('user-1'))[0]!.endpointHash
      const response = await app.request(`/notifications/push/status?endpointHash=${hash}`, { headers: USER_1_HEADERS })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({
        available: true,
        notifyBrowserPush: true,
        vapidPublicKey: VAPID.publicKey,
        vapidKeyId: VAPID.keyId,
        currentSubscription: {
          id: 'sub-1', providerHost: 'fcm.googleapis.com',
          createdAt: '2026-08-01T00:00:00.000Z', lastSuccessAt: '2026-08-06T00:00:00.000Z',
        },
      })
    })

    it('never includes endpoint, p256dh, or auth in the status response', async () => {
      const seeded = pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' })
      pushRepository.seedSubscription(seeded)

      const response = await app.request('/notifications/push/status', { headers: USER_1_HEADERS })
      const serialized = JSON.stringify(await response.json())

      expect(serialized).not.toContain(seeded.endpoint)
      expect(serialized).not.toContain(seeded.p256dh)
      expect(serialized).not.toContain(seeded.auth)
    })

    it('reflects the current Schlussel-sourced preference, false for a user who disabled it', async () => {
      const response = await app.request('/notifications/push/status', { headers: USER_2_HEADERS })
      expect((await response.json() as { notifyBrowserPush: boolean }).notifyBrowserPush).toBe(false)
    })

    it('never leaks another user subscriptions through the caller own status response', async () => {
      pushRepository.seedSubscription(pushSubscriptionRecord({
        id: 'sub-theirs', userId: 'user-2', endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/theirs',
      }))

      const response = await app.request('/notifications/push/status', { headers: USER_1_HEADERS })

      expect((await response.json() as { currentSubscription: unknown }).currentSubscription).toBeNull()
    })

    it('correlates one browser without exposing another subscription from the same account', async () => {
      const current = pushSubscriptionRecord({ id: 'current', sessionId: 'session-1' })
      pushRepository.seedSubscription(current)
      pushRepository.seedSubscription(pushSubscriptionRecord({
        id: 'other-session', sessionId: 'session-2', endpoint: 'https://fcm.googleapis.com/fcm/send/other-session',
      }))

      const response = await app.request(`/notifications/push/status?endpointHash=${current.endpointHash}`, { headers: USER_1_HEADERS })

      expect((await response.json() as { currentSubscription: { id: string } | null }).currentSubscription?.id).toBe('current')
    })

    it('marks the response private, no-store, no-cache, and nosniff', async () => {
      const response = await app.request('/notifications/push/status', { headers: USER_1_HEADERS })
      expectPrivateNoCacheResponse(response)
    })

    it('requires authentication', async () => {
      const response = await app.request('/notifications/push/status')
      expect(response.status).toBe(401)
      expectPrivateNoCacheResponse(response)
    })

    it('rejects a legacy access token without a stable session claim', async () => {
      delete sessions[USER_1_HEADERS.Authorization]
      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT', headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody()),
      })

      expect(response.status).toBe(409)
      expect(await pushRepository.listSubscriptions('user-1')).toEqual([])
    })
  })

  describe('PUT /notifications/push/subscriptions', () => {
    it('registers a new subscription for the authenticated caller, ignoring any owner-shaped field in the body', async () => {
      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody({ userId: 'user-2' })),
      })

      expect(response.status).toBe(200)
      const subscriptions = await pushRepository.listSubscriptions('user-1')
      expect(subscriptions).toHaveLength(1)
      expect(subscriptions[0]?.userId).toBe('user-1')
      expect(await pushRepository.listSubscriptions('user-2')).toEqual([])

      // The response body IS the persisted PushSubscriptionSummary, not a
      // bare {status} - the frontend stores this directly to render
      // "registered" state and to target a later DELETE by id.
      const body = await response.json() as Record<string, unknown>
      expect(body).toEqual({
        id: subscriptions[0]!.id,
        providerHost: subscriptions[0]!.providerHost,
        createdAt: subscriptions[0]!.createdAt,
        lastSuccessAt: null,
      })
      expect(body['id']).toBeTruthy()
      expect(() => new Date(body['createdAt'] as string).toISOString()).not.toThrow()
    })

    it('returns the EXISTING id/createdAt on an update, not freshly generated ones', async () => {
      const endpoint = pushSubscriptionRequestBody()['endpoint'] as string
      const original = pushSubscriptionRecord({ id: 'sub-original', userId: 'user-1', endpoint, createdAt: '2020-01-01T00:00:00.000Z' })
      pushRepository.seedSubscription(original)

      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody({ endpoint })),
      })

      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body['id']).toBe('sub-original')
      expect(body['createdAt']).toBe('2020-01-01T00:00:00.000Z')
      expect(await pushRepository.listSubscriptions('user-1')).toHaveLength(1)
    })

    it('returns 409 when the endpoint already belongs to a different account instead of reattaching it', async () => {
      const body = pushSubscriptionRequestBody()
      pushRepository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-2', endpoint: body['endpoint'] as string }))

      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      expect(response.status).toBe(409)
      expect(await pushRepository.listSubscriptions('user-1')).toEqual([])
      expect((await pushRepository.listSubscriptions('user-2'))[0]?.id).toBe('sub-1')
    })

    it('accepts an explicit null expirationTime, matching Firefox PushSubscription.toJSON()', async () => {
      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody({ expirationTime: null })),
      })

      expect(response.status).toBe(200)
      expect(await pushRepository.listSubscriptions('user-1')).toHaveLength(1)
    })

    it('rejects a provider host absent from the allowlist', async () => {
      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody({ endpoint: 'https://push.attacker.invalid/x' })),
      })

      expect(response.status).toBe(400)
      expect(await pushRepository.listSubscriptions('user-1')).toEqual([])
    })

    it.each([
      'https://127.0.0.1/push',
      'https://169.254.169.254/latest/meta-data',
      'https://push.corp.internal/push',
      'not-a-url',
      'http://fcm.googleapis.com/fcm/send/insecure',
    ])('rejects an SSRF-shaped, insecure, or malformed endpoint: %s', async (endpoint) => {
      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody({ endpoint })),
      })

      expect(response.status).toBe(400)
      expect(await pushRepository.listSubscriptions('user-1')).toEqual([])
    })

    it('enforces the per-user subscription cap', async () => {
      for (let index = 0; index < 10; index += 1) {
        pushRepository.seedSubscription(pushSubscriptionRecord({
          id: `sub-${index}`, userId: 'user-1', endpoint: `https://fcm.googleapis.com/fcm/send/${index}`,
        }))
      }

      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody({ endpoint: 'https://fcm.googleapis.com/fcm/send/over-limit' })),
      })

      expect(response.status).toBe(409)
      expect(await pushRepository.listSubscriptions('user-1')).toHaveLength(10)
    })

    it('marks the response private, no-store, no-cache, and nosniff even on rejection', async () => {
      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody({ endpoint: 'not-a-url' })),
      })
      expectPrivateNoCacheResponse(response)
    })

    it('requires authentication', async () => {
      const response = await app.request('/notifications/push/subscriptions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pushSubscriptionRequestBody()),
      })
      expect(response.status).toBe(401)
    })
  })

  describe('DELETE /notifications/push/subscriptions/:id', () => {
    it('deletes an owned subscription and is idempotent', async () => {
      pushRepository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

      const hash = (await pushRepository.listSubscriptions('user-1'))[0]!.endpointHash
      const first = await app.request(`/notifications/push/subscriptions/sub-1?endpointHash=${hash}`, { method: 'DELETE', headers: USER_1_HEADERS })
      expect(first.status).toBe(204)
      const second = await app.request(`/notifications/push/subscriptions/sub-1?endpointHash=${hash}`, { method: 'DELETE', headers: USER_1_HEADERS })
      expect(second.status).toBe(204)
      expect(await pushRepository.listSubscriptions('user-1')).toEqual([])
    })

    it('returns 404, not 403, for another account subscription id', async () => {
      pushRepository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))

      const hash = (await pushRepository.listSubscriptions('user-1'))[0]!.endpointHash
      const response = await app.request(`/notifications/push/subscriptions/sub-1?endpointHash=${hash}`, { method: 'DELETE', headers: USER_2_HEADERS })

      expect(response.status).toBe(404)
      expect((await pushRepository.listSubscriptions('user-1'))[0]?.id).toBe('sub-1')
    })

    it('marks the response private, no-store, no-cache, and nosniff', async () => {
      pushRepository.seedSubscription(pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' }))
      const hash = (await pushRepository.listSubscriptions('user-1'))[0]!.endpointHash
      const response = await app.request(`/notifications/push/subscriptions/sub-1?endpointHash=${hash}`, { method: 'DELETE', headers: USER_1_HEADERS })
      expectPrivateNoCacheResponse(response)
    })

    it('requires authentication', async () => {
      const response = await app.request('/notifications/push/subscriptions/sub-1', { method: 'DELETE' })
      expect(response.status).toBe(401)
    })
  })

  describe('signed session cleanup', () => {
    it('deletes only subscriptions bound to the revoked user session', async () => {
      pushRepository.seedSubscription(pushSubscriptionRecord({ id: 'session-1-sub', sessionId: 'session-1' }))
      pushRepository.seedSubscription(pushSubscriptionRecord({
        id: 'session-2-sub', sessionId: 'session-2', endpoint: 'https://fcm.googleapis.com/fcm/send/session-2',
      }))
      const body = JSON.stringify({
        version: '1', id: '10000000-0000-4000-8000-000000000091',
        type: 'schlussel.push.session_revoked.v1', source: 'schlussel',
        occurredAt: '2026-08-07T10:00:00.000Z', correlationId: '10000000-0000-4000-8000-000000000092',
        payload: { recipientId: 'user-1', sessionId: 'session-1' },
      })
      const timestamp = Math.floor(Date.parse('2026-08-07T10:00:00.000Z') / 1_000)
      const signature = signNotificationRequest({
        secret: SCHLUSSEL_SECRET, keyId: 'schlussel-test', source: 'schlussel', timestamp,
        method: 'POST', path: '/internal/v1/events', rawBody: body,
      })

      const response = await app.request('/internal/v1/events', {
        method: 'POST', body, headers: {
          'Content-Type': 'application/json', 'X-Hof-Service': 'schlussel', 'X-Hof-Key-Id': 'schlussel-test',
          'X-Hof-Timestamp': String(timestamp), 'X-Hof-Signature': signature,
        },
      })

      expect(response.status).toBe(202)
      expect(pushRepository.subscriptions.map((subscription) => subscription.id)).toEqual(['session-2-sub'])
    })
  })

  describe('no secret leakage', () => {
    it('never echoes endpoint, p256dh, auth, or the VAPID private key anywhere in a PUT response body, including on rejection', async () => {
      const body = pushSubscriptionRequestBody()
      const responses = await Promise.all([
        app.request('/notifications/push/subscriptions', {
          method: 'PUT', headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
        app.request('/notifications/push/subscriptions', {
          method: 'PUT', headers: { ...USER_1_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(pushSubscriptionRequestBody({ endpoint: 'not-a-url' })),
        }),
      ])
      const keys = body['keys'] as { p256dh: string; auth: string }
      for (const response of responses) {
        const serialized = await response.text()
        expect(serialized).not.toContain(keys.p256dh)
        expect(serialized).not.toContain(keys.auth)
        expect(serialized).not.toContain(VAPID.privateKey)
      }
    })

    it('never includes push subscription secrets or the VAPID private key in the notifications export', async () => {
      const seeded = pushSubscriptionRecord({ id: 'sub-1', userId: 'user-1' })
      pushRepository.seedSubscription(seeded)

      const response = await app.request('/exports/me', { headers: USER_1_HEADERS })
      const serialized = await response.text()

      expect(serialized).not.toContain(seeded.endpoint)
      expect(serialized).not.toContain(seeded.p256dh)
      expect(serialized).not.toContain(seeded.auth)
      expect(serialized).not.toContain(VAPID.privateKey)
    })
  })
})
