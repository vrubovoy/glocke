import { createHash } from 'node:crypto'

// CONTRACT: the shapes declared here are what backend/src/contracts.ts
// must eventually export as `PushSubscriptionRecord`, `PushDeliveryRecord`,
// and `PushDeliveryState` (plus the extended `Recipient` with
// `notifyBrowserPush: boolean` - see helpers/repository.ts's
// MemoryNotificationRepository for the extended NotificationRepository
// surface: `materializeNotification` and `listActiveSubscriptions`).
// They are declared locally here - not imported from contracts.ts -
// because contracts.ts does not export them yet. These fixtures, together
// with the rest of this __tests__ suite, ARE the specification the
// implementation must satisfy.
//
// All timestamp fields are ISO strings, matching this repo's existing
// convention in contracts.ts (NotificationRecord, InboxRecord) - the
// SQLite repository layer is responsible for the Date<->string mapping,
// exactly like SqliteNotificationRepository already does today.

export type PushDeliveryState = 'pending' | 'processing' | 'delivered' | 'suppressed' | 'permanent'

export interface PushSubscriptionRecord {
  id: string
  userId: string
  sessionId: string | null
  endpoint: string
  endpointHash: string
  p256dh: string
  auth: string
  expirationTime: string | null
  providerHost: string
  vapidKeyId: string
  createdAt: string
  updatedAt: string
  lastSuccessAt: string | null
}

export interface PushDeliveryRecord {
  id: string
  eventId: string
  source: string
  userId: string
  subscriptionId: string
  destinationUrl: string
  state: PushDeliveryState
  attempts: number
  nextAttemptAt: string | null
  leaseId: string | null
  leaseUntil: string | null
  deliveredAt: string | null
  lastStatus: number | null
  lastError: string | null
  settledAt: string | null
}

// Test-only VAPID material - never real key bytes, but shaped plausibly.
export const VAPID = {
  keyId: 'vapid-2026-08',
  publicKey: 'BNbxGYNMhAxq_test_public_key_placeholder_not_a_real_key_material',
  privateKey: 'test-only-vapid-private-key-must-never-appear-in-any-response',
  subject: 'mailto:push@glocke.example.test',
}

export const GOOGLE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123def456'
export const MOZILLA_ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/xyz789'
export const P256DH = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
export const AUTH = 'tBHItJI5svbpez7KI4CCXg'

function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

export function pushSubscriptionRecord(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  const endpoint = overrides.endpoint ?? GOOGLE_ENDPOINT
  return {
    id: 'subscription-1',
    userId: 'user-1',
    sessionId: 'session-1',
    endpoint,
    endpointHash: endpointHash(endpoint),
    p256dh: P256DH,
    auth: AUTH,
    expirationTime: null,
    providerHost: 'fcm.googleapis.com',
    vapidKeyId: VAPID.keyId,
    createdAt: '2026-08-07T09:00:00.000Z',
    updatedAt: '2026-08-07T09:00:00.000Z',
    lastSuccessAt: null,
    ...overrides,
  }
}

export function pushDeliveryRecord(overrides: Partial<PushDeliveryRecord> = {}): PushDeliveryRecord {
  return {
    id: 'delivery-1',
    eventId: '10000000-0000-4000-8000-000000000001',
    source: 'tafel',
    userId: 'user-1',
    subscriptionId: 'subscription-1',
    destinationUrl: 'https://glocke.example.test/notifications',
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    leaseId: null,
    leaseUntil: null,
    deliveredAt: null,
    lastStatus: null,
    lastError: null,
    settledAt: null,
    ...overrides,
  }
}

// Raw `PushSubscription.toJSON()` shape, exactly as the frontend PUTs it.
export function pushSubscriptionRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { keys, ...rest } = overrides as { keys?: Record<string, unknown> }
  return {
    endpoint: GOOGLE_ENDPOINT,
    keys: { p256dh: P256DH, auth: AUTH, ...keys },
    ...rest,
  }
}
