import { serve } from '@hono/node-server'
import { createId } from '@paralleldrive/cuid2'
import {
  createAuthMiddleware,
  createExportAuthMiddleware,
} from '@zudar107/schloss-server-kit'
import { eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { createApp } from './app.js'
import { db, sqlite } from './db/index.js'
import { parseMigrateOnStartup, prepareDatabase } from './db/migrate.js'
import { users, userTombstones } from './db/schema.js'
import { createHttpApp } from './http.js'
import { createProcessor } from './processor.js'
import { SqlitePushRepository } from './push-repository.js'
import { createPushWorker } from './push-worker.js'
import { createWebPushAdapter } from './web-push-adapter.js'
import { SqliteNotificationRepository } from './repository.js'
import { createSchlusselRecipientResolver } from './schlussel.js'
import { loadConfig } from './config.js'
import { deletionsRouter } from './deletions.js'

const config = loadConfig()
prepareDatabase(db, sqlite, parseMigrateOnStartup(process.env['MIGRATE_ON_STARTUP']))

const repository = new SqliteNotificationRepository(db)
const pushRepository = new SqlitePushRepository(db)
const resolveRecipient = createSchlusselRecipientResolver({
  baseUrl: config.schlusselInternalUrl,
  keyId: config.schlusselKeyId,
  secret: config.schlusselSecret,
  fetchTimeoutMs: config.recipientFetchTimeoutMs,
})
const { requireAuth, requireAdmin } = createAuthMiddleware({
  jwksUrl: config.jwksUrl,
  issuer: config.jwtIssuer,
  onUserSeen: async (user) => {
    const deleted = db.transaction((tx) => {
      const tombstone = tx.select({ userId: userTombstones.userId })
        .from(userTombstones).where(eq(userTombstones.userId, user.id)).get()
      if (tombstone) return true
      const timestamp = new Date()
      tx.insert(users).values({
        id: user.id, email: user.email, name: user.name, createdAt: timestamp, lastSeenAt: timestamp,
      }).onConflictDoUpdate({
        target: users.id,
        set: { email: user.email, name: user.name, lastSeenAt: timestamp },
      }).run()
      return false
    })
    if (deleted) throw new Error('Deleted account')
  },
})
const requireExportAuth = createExportAuthMiddleware({
  jwksUrl: config.jwksUrl,
  issuer: config.jwtIssuer,
  service: 'glocke',
})

// Deterministic from the public key itself rather than a separate env var -
// automatically changes on key rotation, which is exactly when subscriptions
// tagged with the old id need identifying (see push_subscriptions.vapidKeyId).
const vapidKeyId = config.push.vapid
  ? createHash('sha256').update(config.push.vapid.publicKey).digest('hex').slice(0, 12)
  : null

const service = createApp({
  repository,
  sourceCredentials: config.producers,
  requireAuth,
  requireAdmin,
  requireExportAuth,
  maxSkewSeconds: config.maxSkewSeconds,
  maxEventBytes: config.maxEventBytes,
  ready: async () => {
    try {
      db.get(sql`select 1`)
      return true
    } catch {
      return false
    }
  },
  pushRepository,
  resolveRecipient,
  pushConfig: {
    available: config.push.enabled,
    vapidPublicKey: config.push.vapid?.publicKey ?? null,
    vapidKeyId,
    allowedProviderHosts: config.push.allowedProviderHosts,
    maxSubscriptionsPerUser: config.push.maxSubscriptionsPerUser,
  },
  isTombstoned: async (userId) => Boolean(await db.select({ userId: userTombstones.userId })
    .from(userTombstones).where(eq(userTombstones.userId, userId)).get()),
})
service.route('/internal/v1', deletionsRouter)

const app = createHttpApp(service, config.allowedOrigins)

const processor = createProcessor({
  repository,
  resolveRecipient,
  sourceOrigins: config.sourceOrigins,
  createId,
  createPushDeliveryId: createId,
  createLeaseId: createId,
  leaseMs: config.workerLeaseMs,
  glockeOrigin: config.glockePublicUrl,
})
const workerIntervalMs = config.workerIntervalMs
let workerStopped = false
let workerRunning = false
let workerPromise: Promise<void> | null = null

function runWorker() {
  if (workerStopped || workerRunning) return
  workerRunning = true
  workerPromise = (async () => {
    try {
      while (!workerStopped && await processor.processNext() === 'processed') {
        // Drain durable work before sleeping.
      }
    } catch (error) {
      console.error('[Glocke worker] Processing failed', error)
    } finally {
      workerRunning = false
    }
  })()
}

const workerTimer = setInterval(runWorker, workerIntervalMs)
workerTimer.unref()
runWorker()

const pushWorker = config.push.enabled && config.push.vapid
  ? createPushWorker({
    repository: pushRepository,
    resolveRecipient,
    adapter: createWebPushAdapter(),
    vapid: config.push.vapid,
    vapidKeyId: vapidKeyId ?? undefined,
    createLeaseId: createId,
    leaseMs: config.push.workerLeaseMs,
    fetchTimeoutMs: config.push.fetchTimeoutMs,
    maxAttempts: config.push.maxAttempts,
    baseDelayMs: config.push.baseDelayMs,
    maxDelayMs: config.push.maxDelayMs,
    intervalMs: config.push.workerIntervalMs,
  })
  : null
pushWorker?.start()

// Periodic safety net for accounts deleted directly in Schlussel without
// going through a Glocke-observed flow - re-checks every currently
// subscribed user against the same recipient resolver the worker itself
// uses, rather than requiring a bulk "list every user" endpoint that
// doesn't otherwise exist.
let reconciliationTimer: ReturnType<typeof setInterval> | null = null
if (pushWorker) {
  const runReconciliation = async () => {
    try {
      const subscriptions = await pushRepository.listAllSubscriptions()
      const userIds = [...new Set(subscriptions.map((subscription) => subscription.userId))]
      const existing = new Set<string>()
      for (const userId of userIds) {
        if (await resolveRecipient(userId)) existing.add(userId)
      }
      await pushWorker.reconcile(existing)
      const maintenanceAt = new Date()
      await pushRepository.deleteExpiredOrRotatedSubscriptions(maintenanceAt.toISOString(), vapidKeyId!)
      await pushRepository.purgeTerminalDeliveries(
        new Date(maintenanceAt.getTime() - config.push.retentionMs).toISOString(),
      )
    } catch (error) {
      console.error('[Glocke push worker] Reconciliation failed', error)
    }
  }
  reconciliationTimer = setInterval(() => void runReconciliation(), 60 * 60_000)
  reconciliationTimer.unref()
  void runReconciliation()
}

const port = config.port
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`[Glocke API] Running on http://localhost:${port}`)
})

function shutdown(signal: string) {
  if (workerStopped) return
  workerStopped = true
  clearInterval(workerTimer)
  if (reconciliationTimer) clearInterval(reconciliationTimer)
  console.log(`[Glocke API] ${signal}; stopping`)
  server.close(() => {
    void (async () => {
      await workerPromise
      await pushWorker?.stop()
      sqlite.close()
      process.exit(0)
    })()
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

export { app }
