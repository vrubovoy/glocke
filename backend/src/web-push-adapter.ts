import webPush from 'web-push'
import { parseRetryAfter } from '@zudar107/schloss-server-kit'
import type { PushAdapter, PushAdapterSendArgs, PushAdapterSendResult } from './push-worker.js'

// The only seam that ever touches the network for browser push - wraps
// `web-push` behind the structured PushAdapter contract (never throws, owns
// its own timeout) so push-worker.ts stays fully unit-testable without a
// real network call.
export function createWebPushAdapter(): PushAdapter {
  return {
    async send({ subscription, payload, vapid, timeoutMs }: PushAdapterSendArgs): Promise<PushAdapterSendResult> {
      try {
        const response = await webPush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify(payload),
          {
            vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
            TTL: 60,
            timeout: timeoutMs,
          },
        )
        const retryAfterMs = parseWebPushRetryAfter(response.headers['retry-after'])
        return { outcome: 'sent', status: response.statusCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
      } catch (error) {
        if (isWebPushError(error)) {
          const retryAfterMs = parseWebPushRetryAfter(error.headers?.['retry-after'])
          return { outcome: 'sent', status: error.statusCode, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
        }
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          return { outcome: 'timeout' }
        }
        return { outcome: 'network-error', message: error instanceof Error ? error.message : 'Unknown push delivery error' }
      }
    },
  }
}

export function parseWebPushRetryAfter(value: string | undefined, now: () => number = Date.now): number | undefined {
  return parseRetryAfter(value, { now })
}

interface WebPushError extends Error {
  statusCode: number
  headers: Record<string, string>
}

function isWebPushError(error: unknown): error is WebPushError {
  return error instanceof Error && 'statusCode' in error && typeof (error as { statusCode: unknown }).statusCode === 'number'
}
