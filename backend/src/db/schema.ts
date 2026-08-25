import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
})

export const inboxEvents = sqliteTable('inbox_events', {
  source: text('source').notNull(),
  eventId: text('event_id').notNull(),
  userId: text('user_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  envelope: text('envelope').notNull(),
  status: text('status', { enum: ['pending', 'processing', 'processed'] }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }).notNull(),
  processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
  leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
  leaseId: text('lease_id'),
}, (table) => [
  primaryKey({ columns: [table.source, table.eventId] }),
  index('inbox_claim_idx').on(table.status, table.leaseUntil, table.acceptedAt),
])

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  eventId: text('event_id').notNull(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  actionUrl: text('action_url'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  readAt: integer('read_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('notifications_event_recipient_unique').on(table.source, table.eventId, table.userId),
  index('notifications_user_created_idx').on(table.userId, table.createdAt, table.id),
  index('notifications_user_unread_idx').on(table.userId, table.readAt),
])

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  // Null only for rows created before session-bound Browser Push.
  sessionId: text('session_id'),
  endpoint: text('endpoint').notNull(),
  endpointHash: text('endpoint_hash').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  expirationTime: integer('expiration_time', { mode: 'timestamp_ms' }),
  providerHost: text('provider_host').notNull(),
  vapidKeyId: text('vapid_key_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('push_subscriptions_endpoint_unique').on(table.endpoint),
  index('push_subscriptions_user_idx').on(table.userId),
])

export const pushDeliveries = sqliteTable('push_deliveries', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  source: text('source').notNull(),
  userId: text('user_id').notNull(),
  subscriptionId: text('subscription_id').notNull(),
  destinationUrl: text('destination_url').notNull(),
  state: text('state', { enum: ['pending', 'processing', 'delivered', 'suppressed', 'permanent'] }).notNull(),
  attempts: integer('attempts').notNull(),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
  leaseId: text('lease_id'),
  leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
  deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' }),
  lastStatus: integer('last_status'),
  lastError: text('last_error'),
  settledAt: integer('settled_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('push_deliveries_event_subscription_unique').on(table.eventId, table.source, table.subscriptionId),
  index('push_deliveries_subscription_idx').on(table.subscriptionId),
  index('push_deliveries_claim_idx').on(table.state, table.leaseUntil, table.nextAttemptAt),
  index('push_deliveries_retention_idx').on(table.state, table.settledAt),
])
