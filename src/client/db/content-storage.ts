import type { Sqlite3Db } from './sqlite-init.js'
import { execDb } from './local-db.js'

export async function purgeStoredContent (db:Sqlite3Db):Promise<void> {
    await execDb(db, {
        sql: `UPDATE items
              SET content = NULL,
                  description = NULL
              WHERE content IS NOT NULL
                 OR description IS NOT NULL`
    })
}
