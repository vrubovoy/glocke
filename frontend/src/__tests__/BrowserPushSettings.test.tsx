import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPushSettings } from '../features/settings/BrowserPushSettings'
import { api, ApiError } from '../lib/api'

// ============================================================================
// Implementation contract (not yet implemented — module-not-found expected
// until frontend/src/features/settings/BrowserPushSettings.tsx exists):
//
//   export function BrowserPushSettings(): JSX.Element
//
// Renders the new Settings section "Уведомления в браузере на этом
// устройстве". Fetches GET /notifications/push/status on mount (via the
// shared `api` client from ../../lib/api) whenever the browser is capable
// and in a secure context — never otherwise (no wasted network call for a
// browser that can't act on the result anyway).
//
// STATE CONTRACT: exactly one of the following is rendered at a time, each
// as a single container with a stable `role` + `aria-label` pair (chosen so
// tests target behavior/state rather than exact Russian copy, per the
// spec's own guidance, while still doubling as a real accessible
// announcement — role="alert"/"status" carry implicit aria-live):
//
//   role="status" aria-label="push-unsupported"                 — capability missing
//   role="status" aria-label="push-insecure-context"             — not https/localhost
//   role="status" aria-label="push-status-loading"                — initial GET /status in flight
//   role="alert"  aria-label="push-status-error"                  — GET /status failed; has a retry button (name: /повтор/i)
//   role="status" aria-label="push-permission-denied"             — Notification.permission === 'denied'
//   role="status" aria-label="push-global-disabled"               — status.notifyBrowserPush === false
//   role="status" aria-label="push-permission-not-requested"      — permission 'default', enable available
//   role="status" aria-label="push-granted-no-subscription"       — permission 'granted', no subscription yet, enable available
//   role="status" aria-label="push-subscribed"                    — subscriptions.length > 0
//   role="alert"  aria-label="push-enable-error"                  — enable flow failed (non-409 backend rejection or network error)
//   role="alert"  aria-label="push-repair-conflict"                — PUT returned 409 (endpoint owned by a different account)
//   role="alert"  aria-label="push-repair-partial"                 — disable flow partial failure
//
// Only "push-permission-not-requested" and "push-granted-no-subscription"
// render an Enable button (accessible name matches /включить/i). Only
// "push-subscribed" renders a Disable button (name matches /отключить/i).
// "push-repair-conflict" and "push-repair-partial" each render a repair
// button (name matches /восстанов/i).
//
// ENABLE FLOW (explicit click only, never automatic):
//   1. navigator.serviceWorker.register('/sw.js', { scope: '/' })
//   2. Notification.requestPermission()
//   3. reuse the vapidPublicKey already fetched via the mount-time GET
//      /notifications/push/status (no extra GET per click)
//   4. registration.pushManager.subscribe({ userVisibleOnly: true,
//      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) })
//   5. api.put('/notifications/push/subscriptions', subscription.toJSON())
//   6. only transition to push-subscribed after step 5 resolves (2xx)
//
// DISABLE FLOW (only reachable from push-subscribed):
//   1. api.delete('/notifications/push/subscriptions/:id')
//   2. navigator.serviceWorker.ready -> registration.pushManager.getSubscription() -> subscription.unsubscribe()
//   3. both succeed -> push-granted-no-subscription (or push-permission-not-requested,
//      whichever matches current Notification.permission)
//   4. exactly one of the two steps fails -> push-repair-partial
// ============================================================================

vi.mock('../lib/api', () => {
  class MockApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return {
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
    ApiError: MockApiError,
  }
})

const VAPID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa40HI0DLLuxazjxTQyxUAsxdWyPRXHy8jSGKk8jKZ0v3OA5rVUZ0KKnj8bJx0'

const noSubStatus = {
  available: true,
  notifyBrowserPush: true,
  vapidPublicKey: VAPID_KEY,
  vapidKeyId: 'key-1',
  currentSubscription: null as { id: string; providerHost: string; createdAt: string; lastSuccessAt: string | null } | null,
}

const subscribedStatus = {
  ...noSubStatus,
  currentSubscription: { id: 'sub-1', providerHost: 'fcm.googleapis.com', createdAt: '2026-08-10T09:00:00.000Z', lastSuccessAt: '2026-08-17T09:00:00.000Z' },
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeSubscription(overrides: Partial<{ endpoint: string; unsubscribeResult: boolean }> = {}) {
  return {
    endpoint: overrides.endpoint ?? 'https://fcm.googleapis.com/fcm/send/abc123',
    toJSON: () => ({
      endpoint: overrides.endpoint ?? 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      expirationTime: null,
    }),
    unsubscribe: vi.fn().mockResolvedValue(overrides.unsubscribeResult ?? true),
  }
}

function makeRegistration(subscribeImpl?: () => Promise<ReturnType<typeof makeSubscription>>) {
  const subscription = makeSubscription()
  return {
    pushManager: {
      subscribe: vi.fn(subscribeImpl ?? (() => Promise.resolve(subscription))),
      getSubscription: vi.fn(() => Promise.resolve(subscription)),
    },
  }
}

/** Full "everything works" browser capability baseline. Individual tests override pieces. */
function stubCapableSecureBrowser({
  registration = makeRegistration(),
  permission = 'default' as NotificationPermission,
}: { registration?: ReturnType<typeof makeRegistration>; permission?: NotificationPermission } = {}) {
  vi.stubGlobal('isSecureContext', true)

  class FakeNotification {
    static permission: NotificationPermission = permission
    static requestPermission = vi.fn().mockResolvedValue(permission === 'default' ? 'granted' : permission)
  }
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('PushManager', class {})

  const register = vi.fn().mockResolvedValue(registration)
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register, ready: Promise.resolve(registration), getRegistration: vi.fn().mockResolvedValue(registration) },
  })

  return { registration, FakeNotification, register }
}

describe('BrowserPushSettings', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.put).mockReset()
    vi.mocked(api.delete).mockReset()
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('no automatic permission prompt', () => {
    it('never calls Notification.requestPermission on mount, even once the status fetch settles', async () => {
      const { FakeNotification } = stubCapableSecureBrowser({ permission: 'default' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)

      render(<BrowserPushSettings />)
      await screen.findByRole('status', { name: 'push-permission-not-requested' })

      expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    })

    it('does not prompt even while the status fetch is still pending', () => {
      stubCapableSecureBrowser({ permission: 'default' })
      vi.mocked(api.get).mockReturnValue(new Promise(() => {}))

      render(<BrowserPushSettings />)

      const notif = window.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }
      expect(notif.requestPermission).not.toHaveBeenCalled()
    })
  })

  describe('capability / permission / subscription states', () => {
    it('renders the unsupported-browser state and skips the status fetch entirely', async () => {
      vi.stubGlobal('isSecureContext', true)
      // Deliberately do not stub serviceWorker/PushManager/Notification —
      // jsdom lacks them by default, matching an unsupported browser.

      render(<BrowserPushSettings />)

      expect(await screen.findByRole('status', { name: 'push-unsupported' })).toBeInTheDocument()
      expect(api.get).not.toHaveBeenCalled()
    })

    it('renders the insecure-context state and skips the status fetch entirely', async () => {
      stubCapableSecureBrowser()
      vi.stubGlobal('isSecureContext', false)

      render(<BrowserPushSettings />)

      expect(await screen.findByRole('status', { name: 'push-insecure-context' })).toBeInTheDocument()
      expect(api.get).not.toHaveBeenCalled()
    })

    it('renders a loading state while the initial status fetch is pending', () => {
      stubCapableSecureBrowser()
      vi.mocked(api.get).mockReturnValue(new Promise(() => {}))

      render(<BrowserPushSettings />)

      expect(screen.getByRole('status', { name: 'push-status-loading' })).toBeInTheDocument()
    })

    it('renders a distinct error state with retry when the status fetch fails', async () => {
      stubCapableSecureBrowser()
      vi.mocked(api.get).mockRejectedValueOnce(new Error('network unavailable'))
      vi.mocked(api.get).mockResolvedValueOnce(noSubStatus)

      const user = userEvent.setup()
      render(<BrowserPushSettings />)

      const errorRegion = await screen.findByRole('alert', { name: 'push-status-error' })
      const retry = within(errorRegion).getByRole('button', { name: /повтор/i })
      await user.click(retry)

      await screen.findByRole('status', { name: 'push-permission-not-requested' })
      expect(api.get).toHaveBeenCalledTimes(2)
    })

    it('renders the permission-denied state distinctly, with no enable button', async () => {
      stubCapableSecureBrowser({ permission: 'denied' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)

      render(<BrowserPushSettings />)

      expect(await screen.findByRole('status', { name: 'push-permission-denied' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /включить/i })).not.toBeInTheDocument()
    })

    it('renders the global-preference-disabled state distinctly, with no enable button', async () => {
      stubCapableSecureBrowser({ permission: 'default' })
      vi.mocked(api.get).mockResolvedValue({ ...noSubStatus, notifyBrowserPush: false })

      render(<BrowserPushSettings />)

      expect(await screen.findByRole('status', { name: 'push-global-disabled' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /включить/i })).not.toBeInTheDocument()
    })

    it('renders the permission-not-requested state with an enable button', async () => {
      stubCapableSecureBrowser({ permission: 'default' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)

      render(<BrowserPushSettings />)

      const region = await screen.findByRole('status', { name: 'push-permission-not-requested' })
      expect(within(region).getByRole('button', { name: /включить/i })).toBeInTheDocument()
    })

    it('renders the granted-no-subscription state distinctly from permission-not-requested, with an enable button', async () => {
      stubCapableSecureBrowser({ permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)

      render(<BrowserPushSettings />)

      const region = await screen.findByRole('status', { name: 'push-granted-no-subscription' })
      expect(within(region).getByRole('button', { name: /включить/i })).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: 'push-permission-not-requested' })).not.toBeInTheDocument()
    })

    it('renders the subscribed state with provider host and created date, never the raw endpoint', async () => {
      stubCapableSecureBrowser({ permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(subscribedStatus)

      render(<BrowserPushSettings />)

      const region = await screen.findByRole('status', { name: 'push-subscribed' })
      expect(within(region).getByText(/fcm\.googleapis\.com/)).toBeInTheDocument()
      expect(within(region).getByRole('button', { name: /отключить/i })).toBeInTheDocument()
      expect(screen.queryByText(/fcm\/send\/abc123/)).not.toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/p256dh-key|auth-key/)
    })
  })

  describe('enable flow', () => {
    it('succeeds end-to-end: registers the worker, requests permission, subscribes, and PUTs the subscription', async () => {
      const registration = makeRegistration()
      const { register, FakeNotification } = stubCapableSecureBrowser({ registration, permission: 'default' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      vi.mocked(api.put).mockResolvedValue({ id: 'sub-1', providerHost: 'fcm.googleapis.com', createdAt: '2026-08-18T09:00:00.000Z', lastSuccessAt: null })

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      await waitFor(() => expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' }))
      expect(FakeNotification.requestPermission).toHaveBeenCalledOnce()
      await waitFor(() => expect(registration.pushManager.subscribe).toHaveBeenCalledOnce())
      const subscribeCalls = registration.pushManager.subscribe.mock.calls as unknown as
        [{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }][]
      const subscribeArgs = subscribeCalls[0]?.[0]
      expect(subscribeArgs?.userVisibleOnly).toBe(true)
      expect(subscribeArgs?.applicationServerKey).toBeInstanceOf(Uint8Array)

      await waitFor(() => expect(api.put).toHaveBeenCalledWith('/notifications/push/subscriptions', expect.objectContaining({ endpoint: expect.any(String) })))
      expect(await screen.findByRole('status', { name: 'push-subscribed' })).toBeInTheDocument()
      // GET /status is only called once (on mount) — the enable flow reuses the cached vapid key.
      expect(api.get).toHaveBeenCalledOnce()
    })

    it('does not show a false success state before the backend PUT resolves (no optimistic UI)', async () => {
      stubCapableSecureBrowser({ permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      const put = deferred<unknown>()
      vi.mocked(api.put).mockReturnValue(put.promise as Promise<never>)

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      await waitFor(() => expect(api.put).toHaveBeenCalledOnce())
      expect(screen.queryByRole('status', { name: 'push-subscribed' })).not.toBeInTheDocument()

      put.resolve({ id: 'sub-1', providerHost: 'fcm.googleapis.com', createdAt: '2026-08-18T09:00:00.000Z', lastSuccessAt: null })
      expect(await screen.findByRole('status', { name: 'push-subscribed' })).toBeInTheDocument()
    })

    it('failure branch: permission denied aborts the flow without calling subscribe or PUT', async () => {
      const registration = makeRegistration()
      stubCapableSecureBrowser({ registration, permission: 'default' })
      // Override requestPermission to resolve 'denied' regardless of stubCapableSecureBrowser's default mapping.
      ;(window.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission = vi.fn().mockResolvedValue('denied')
      vi.mocked(api.get).mockResolvedValue(noSubStatus)

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      expect(await screen.findByRole('status', { name: 'push-permission-denied' })).toBeInTheDocument()
      expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
      expect(api.put).not.toHaveBeenCalled()
    })

    it('failure branch: capability failure during registration (e.g. blocked by permissions policy) surfaces a generic enable error, not a crash or false success', async () => {
      const registration = makeRegistration()
      const { register } = stubCapableSecureBrowser({ registration, permission: 'granted' })
      register.mockRejectedValueOnce(new Error('registration blocked'))
      vi.mocked(api.get).mockResolvedValue(noSubStatus)

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      expect(await screen.findByRole('alert', { name: 'push-enable-error' })).toBeInTheDocument()
      expect(api.put).not.toHaveBeenCalled()
      expect(screen.queryByRole('status', { name: 'push-subscribed' })).not.toBeInTheDocument()
    })

    it('failure branch: backend 4xx rejection surfaces the enable-error state and rolls back to a retryable state', async () => {
      stubCapableSecureBrowser({ permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      vi.mocked(api.put).mockRejectedValue(new ApiError(400, 'invalid subscription'))

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      expect(await screen.findByRole('alert', { name: 'push-enable-error' })).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: 'push-subscribed' })).not.toBeInTheDocument()
      expect(screen.queryByRole('alert', { name: 'push-repair-conflict' })).not.toBeInTheDocument()
    })

    it('failure branch: backend 5xx rejection surfaces the enable-error state', async () => {
      stubCapableSecureBrowser({ permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      vi.mocked(api.put).mockRejectedValue(new ApiError(500, 'internal error'))

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      expect(await screen.findByRole('alert', { name: 'push-enable-error' })).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: 'push-subscribed' })).not.toBeInTheDocument()
    })

    it('failure branch: a plain network error (non-ApiError) surfaces the same enable-error state', async () => {
      stubCapableSecureBrowser({ permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      vi.mocked(api.put).mockRejectedValue(new TypeError('Failed to fetch'))

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      expect(await screen.findByRole('alert', { name: 'push-enable-error' })).toBeInTheDocument()
    })

    it('duplicate-click protection: a rapid second click while step 1-6 is in flight does not start a second parallel enable flow', async () => {
      const registration = makeRegistration()
      const { register } = stubCapableSecureBrowser({ registration, permission: 'granted' })
      const registerCall = deferred<ReturnType<typeof makeRegistration>>()
      register.mockReturnValue(registerCall.promise)
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      vi.mocked(api.put).mockResolvedValue({ id: 'sub-1', providerHost: 'fcm.googleapis.com', createdAt: '2026-08-18T09:00:00.000Z', lastSuccessAt: null })

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      const button = await screen.findByRole('button', { name: /включить/i })
      await user.click(button)
      // Second click while navigator.serviceWorker.register(...) is still pending.
      await user.click(button)

      registerCall.resolve(registration)
      await waitFor(() => expect(api.put).toHaveBeenCalledOnce())

      expect(register).toHaveBeenCalledOnce()
      expect(registration.pushManager.subscribe).toHaveBeenCalledOnce()
      expect(api.put).toHaveBeenCalledOnce()
    })
  })

  describe('account-switch conflict (409)', () => {
    it('routes a 409 from PUT to the repair state instead of silently reattaching', async () => {
      stubCapableSecureBrowser({ permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      vi.mocked(api.put).mockRejectedValue(new ApiError(409, 'endpoint already registered to a different account'))

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))

      expect(await screen.findByRole('alert', { name: 'push-repair-conflict' })).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: 'push-subscribed' })).not.toBeInTheDocument()
    })

    it('repair action unsubscribes the stale browser subscription, then re-subscribes fresh and succeeds', async () => {
      const registration = makeRegistration()
      stubCapableSecureBrowser({ registration, permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(noSubStatus)
      vi.mocked(api.put)
        .mockRejectedValueOnce(new ApiError(409, 'endpoint already registered to a different account'))
        .mockResolvedValueOnce({ id: 'sub-2', providerHost: 'fcm.googleapis.com', createdAt: '2026-08-18T09:00:00.000Z', lastSuccessAt: null })

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      await user.click(await screen.findByRole('button', { name: /включить/i }))
      const conflictRegion = await screen.findByRole('alert', { name: 'push-repair-conflict' })
      const repairButton = within(conflictRegion).getByRole('button', { name: /восстанов/i })

      const firstSubscription = await registration.pushManager.subscribe.mock.results[0].value
      await user.click(repairButton)

      // Once to replace the uncorrelated local subscription, then once to
      // repair the server ownership conflict returned for the fresh write.
      await waitFor(() => expect(firstSubscription.unsubscribe).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2))
      expect(await screen.findByRole('status', { name: 'push-subscribed' })).toBeInTheDocument()
    })
  })

  describe('disable flow', () => {
    it('succeeds end-to-end: DELETEs the server record, then unsubscribes the browser subscription', async () => {
      const registration = makeRegistration()
      stubCapableSecureBrowser({ registration, permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(subscribedStatus)
      vi.mocked(api.delete).mockResolvedValue(undefined)

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      const region = await screen.findByRole('status', { name: 'push-subscribed' })
      await user.click(within(region).getByRole('button', { name: /отключить/i }))

      await waitFor(() => expect(api.delete).toHaveBeenCalledWith(expect.stringMatching(/^\/notifications\/push\/subscriptions\/sub-1\?endpointHash=[0-9a-f]{64}$/)))
      const subscription = await registration.pushManager.getSubscription()
      await waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledOnce())
      expect(await screen.findByRole('status', { name: 'push-granted-no-subscription' })).toBeInTheDocument()
    })

    it('partial-failure branch: server DELETE succeeds but browser unsubscribe fails -> repair-required state', async () => {
      const subscription = makeSubscription({ unsubscribeResult: false })
      const registration = makeRegistration(() => Promise.resolve(subscription))
      registration.pushManager.getSubscription.mockResolvedValue(subscription)
      stubCapableSecureBrowser({ registration, permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(subscribedStatus)
      vi.mocked(api.delete).mockResolvedValue(undefined)

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      const region = await screen.findByRole('status', { name: 'push-subscribed' })
      await user.click(within(region).getByRole('button', { name: /отключить/i }))

      expect(await screen.findByRole('alert', { name: 'push-repair-partial' })).toBeInTheDocument()
      // Not a false "disabled" success.
      expect(screen.queryByRole('status', { name: 'push-granted-no-subscription' })).not.toBeInTheDocument()
    })

    it('partial-failure branch: server DELETE fails but browser unsubscribe succeeds -> repair-required state', async () => {
      const registration = makeRegistration()
      stubCapableSecureBrowser({ registration, permission: 'granted' })
      vi.mocked(api.get).mockResolvedValue(subscribedStatus)
      vi.mocked(api.delete).mockRejectedValue(new ApiError(500, 'internal error'))

      const user = userEvent.setup()
      render(<BrowserPushSettings />)
      const region = await screen.findByRole('status', { name: 'push-subscribed' })
      await user.click(within(region).getByRole('button', { name: /отключить/i }))

      expect(await screen.findByRole('alert', { name: 'push-repair-partial' })).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: 'push-granted-no-subscription' })).not.toBeInTheDocument()
    })
  })
})
