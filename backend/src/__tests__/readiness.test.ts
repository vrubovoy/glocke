import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase } from '../db/migrate.js'
import { createReadinessCheck } from '../readiness.js'

const databases: Database.Database[] = []
const servers: Server[] = []

function database() {
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  return { sqlite, db: drizzle(sqlite) }
}

async function startJwksServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to bind test server')
  return `http://127.0.0.1:${address.port}/`
}

afterEach(async () => {
  for (const sqlite of databases.splice(0)) sqlite.close()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('createReadinessCheck', () => {
  it('reports ready when the schema is current and the JWKS endpoint is reachable', async () => {
    const { sqlite, db } = database()
    migrateDatabase(db)
    const jwksUrl = await startJwksServer((_req, res) => res.end('{"keys":[]}'))

    const ready = createReadinessCheck({ db, sqlite, jwksUrl })
    await expect(ready()).resolves.toBe(true)
  })

  it('reports not ready when the schema has not been migrated', async () => {
    const { sqlite, db } = database()
    const jwksUrl = await startJwksServer((_req, res) => res.end('{"keys":[]}'))

    const ready = createReadinessCheck({ db, sqlite, jwksUrl })
    await expect(ready()).resolves.toBe(false)
  })

  it('reports not ready when Schlüssel is not reachable, even with a current schema', async () => {
    const { sqlite, db } = database()
    migrateDatabase(db)
    const jwksUrl = await startJwksServer((_req, res) => { res.statusCode = 503; res.end('unavailable') })

    const ready = createReadinessCheck({ db, sqlite, jwksUrl })
    await expect(ready()).resolves.toBe(false)
  })
})
