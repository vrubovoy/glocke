// Glocke's push-only service worker. Scope is "/" (registered from the
// Settings page). No fetch handler, no offline caching - deliberately not
// a PWA/install worker. Mirrors frontend/src/sw/{pushPayload,trustedUrl,
// focusClient}.ts exactly (public/ assets are copied as-is by Vite, not
// bundled, so this file cannot import those TS modules directly). Keep the
// three functions below in sync with their TS counterparts by hand.
//
// The worker never receives, stores, or reads a JWT/access token - it has
// no authenticated capability of its own. `pushsubscriptionchange` does not
// attempt any authenticated backend call from here; reconciliation happens
// next time the Settings page loads.

function parsePushPayload(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { id, text, url } = parsed
  if (typeof id !== 'string' || typeof text !== 'string' || typeof url !== 'string') return null
  return { id, text, url }
}

function buildNotificationOptions(payload) {
  return { body: payload.text, tag: payload.id, data: { url: payload.url, id: payload.id } }
}

function resolveTrustedUrl(candidate, fallback) {
  fallback = fallback === undefined ? '/notifications' : fallback
  if (typeof candidate !== 'string' || candidate.length === 0) return fallback
  var url
  try {
    url = new URL(candidate)
  } catch {
    return fallback
  }
  if (url.protocol === 'https:') return candidate
  if (url.protocol === 'http:' && url.hostname === 'localhost') return candidate
  return fallback
}

function decideClickAction(clients, destinationUrl, selfOrigin) {
  var isSameOrigin = false
  try {
    isSameOrigin = new URL(destinationUrl).origin === selfOrigin
  } catch {
    isSameOrigin = false
  }
  var existing = isSameOrigin ? clients.find((client) => new URL(client.url).origin === selfOrigin) : undefined
  return existing ? { action: 'focus', client: existing, url: destinationUrl } : { action: 'open', url: destinationUrl }
}

self.addEventListener('push', (event) => {
  const raw = event.data ? event.data.text() : ''
  const payload = parsePushPayload(raw)
  if (!payload) {
    event.waitUntil(self.registration.showNotification('Glocke', {
      body: 'У вас новое уведомление',
      tag: 'glocke-malformed',
      data: { url: '/notifications' },
    }))
    return
  }
  const trustedUrl = resolveTrustedUrl(payload.url)
  const options = buildNotificationOptions({ ...payload, url: trustedUrl })
  event.waitUntil(self.registration.showNotification('Glocke', options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const destinationUrl = resolveTrustedUrl(event.notification.data && event.notification.data.url)
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const decision = decideClickAction(clients, destinationUrl, self.location.origin)
    if (decision.action === 'focus') {
      const navigated = decision.client.navigate ? await decision.client.navigate(decision.url) : decision.client
      await (navigated || decision.client).focus()
    } else {
      await self.clients.openWindow(decision.url)
    }
  })())
})
