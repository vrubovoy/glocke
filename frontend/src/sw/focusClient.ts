export interface FocusableClient {
  url: string
  focus(): unknown
  navigate?(url: string): unknown
}

export type ClickAction =
  | { action: 'focus'; client: FocusableClient; url: string }
  | { action: 'open'; url: string }

// destinationUrl is assumed already validated by resolveTrustedUrl - this
// only decides focus-vs-open. Same-origin (Glocke) destinations prefer
// focusing an already-open tab/window; anything cross-origin always opens
// directly, regardless of what tabs happen to be open.
export function decideClickAction(
  clients: FocusableClient[],
  destinationUrl: string,
  selfOrigin: string,
): ClickAction {
  let isSameOrigin = false
  try {
    isSameOrigin = new URL(destinationUrl).origin === selfOrigin
  } catch {
    isSameOrigin = false
  }
  const existing = isSameOrigin ? clients.find((client) => new URL(client.url).origin === selfOrigin) : undefined
  return existing ? { action: 'focus', client: existing, url: destinationUrl } : { action: 'open', url: destinationUrl }
}
