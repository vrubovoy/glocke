import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideClickAction, type FocusableClient } from '../sw/focusClient'

// Implementation contract (not yet implemented — module-not-found expected
// until frontend/src/sw/focusClient.ts exists):
//
//   export interface FocusableClient { url: string; focus(): unknown }
//   export type ClickAction =
//     | { action: 'focus'; client: FocusableClient }
//     | { action: 'open'; url: string }
//   export function decideClickAction(
//     clients: FocusableClient[],
//     destinationUrl: string,
//     selfOrigin: string,
//   ): ClickAction
//
// Extracted from the real /sw.js `notificationclick` handler's
// `clients.matchAll(...)` + focus-vs-openWindow branching, per spec: "if the
// destination is same-origin (Glocke), try to focus an existing open Glocke
// tab/window before opening a new one; otherwise open the destination
// directly." `destinationUrl` here is assumed already validated by
// resolveTrustedUrl (see swTrustedUrl.test.ts) — this function only decides
// focus-vs-open, it does not re-validate trust.

function client(url: string): FocusableClient {
  return { url, focus: () => Promise.resolve() }
}

describe('decideClickAction', () => {
  const selfOrigin = 'https://glocke.example.com'

  it('focuses an existing same-origin client when the destination is same-origin', () => {
    const existing = client('https://glocke.example.com/notifications')
    const result = decideClickAction([existing], 'https://glocke.example.com/notifications/delivery-1', selfOrigin)
    expect(result).toEqual({ action: 'focus', client: existing, url: 'https://glocke.example.com/notifications/delivery-1' })
  })

  it('opens a new window when the destination is same-origin but no client is open', () => {
    const result = decideClickAction([], 'https://glocke.example.com/notifications/delivery-1', selfOrigin)
    expect(result).toEqual({ action: 'open', url: 'https://glocke.example.com/notifications/delivery-1' })
  })

  it('opens the destination directly (ignoring open clients) when it is cross-origin', () => {
    const existing = client('https://glocke.example.com/notifications')
    const result = decideClickAction([existing], 'https://other-service.example.com/x', selfOrigin)
    expect(result).toEqual({ action: 'open', url: 'https://other-service.example.com/x' })
  })

  it('picks one of several open same-origin clients rather than opening a new window', () => {
    const clients = [client('https://glocke.example.com/settings'), client('https://glocke.example.com/notifications')]
    const result = decideClickAction(clients, 'https://glocke.example.com/notifications/delivery-1', selfOrigin)
    expect(result.action).toBe('focus')
    if (result.action === 'focus') {
      expect(clients).toContainEqual(result.client)
    }
  })
})

// --- Negative check: no fetch-event interception in the worker ---
//
// Per spec: "No fetch-event interception exists in the worker at all
// (explicit negative test, since accidentally adding one would silently
// start caching/offline behavior we don't want)." frontend/public/sw.js now
// exists (promoted from the original it.todo once it was implemented).
describe('sw.js fetch-event interception (structural)', () => {
  it('addEventListener("fetch", ...) is never registered in frontend/public/sw.js', () => {
    const source = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8')
    expect(source).not.toMatch(/addEventListener\(\s*['"]fetch['"]/)
  })
})
