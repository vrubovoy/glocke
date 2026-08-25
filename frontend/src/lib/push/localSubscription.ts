export async function getLocalPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const registration = typeof navigator.serviceWorker.getRegistration === 'function'
    ? await navigator.serviceWorker.getRegistration('/')
    : await navigator.serviceWorker.ready
  return registration?.pushManager.getSubscription() ?? null
}

export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function unsubscribeLocalPush(): Promise<boolean> {
  const subscription = await getLocalPushSubscription()
  return subscription ? subscription.unsubscribe() : true
}
