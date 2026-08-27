import { checkJwksReachable } from '@zudar107/schloss-server-kit'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { assertSchemaCurrent } from './db/migrate.js'
import type { db as realDb } from './db/index.js'

export interface CreateReadinessCheckOptions {
  db: Pick<typeof realDb, 'get'>
  sqlite: SqliteDatabase
  jwksUrl: string
}

// Own schema currency alone reports healthy even when Glocke can no
// longer reach the one mandatory dependency every authenticated request
// needs - Schlüssel's JWKS. Extracted from index.ts so it's unit-testable
// without booting the real app (index.ts starts an HTTP listener as an
// import-time side effect).
export function createReadinessCheck(options: CreateReadinessCheckOptions): () => Promise<boolean> {
  const { db, sqlite, jwksUrl } = options
  return async () => {
    try {
      db.get(sql`select 1`)
      assertSchemaCurrent(sqlite)
    } catch {
      return false
    }
    return checkJwksReachable(jwksUrl)
  }
}
