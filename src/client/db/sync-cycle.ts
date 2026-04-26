import type { Sqlite3Db } from './sqlite-init.js'
import { pullSync } from './pull-sync.js'
import { pushSync } from './push-sync.js'

/**
 * Run one local-first sync cycle. Push goes first so optimistic writes
 * reach the server before pull can merge newer remote rows.
 */
export async function runSyncCycle (
    db:Sqlite3Db,
    fetchFn:typeof fetch = fetch
):Promise<void> {
    await pushSync(db, fetchFn as Parameters<typeof pushSync>[1])
    await pullSync(db, fetchFn)
}
