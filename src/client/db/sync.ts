import type { Sqlite3Db } from './sqlite-init.js'
import {
    PullSyncAuthError,
    pullSync
} from './pull-sync.js'
import {
    getDeadLetterOutboxCount,
    getOutboxCount,
    PushSyncAuthError,
    pushSync
} from './push-sync.js'
import {
    isLocalFirstActive,
    setSyncDone,
    setSyncError,
    setSyncSyncing
} from './sync-status.js'

/**
 * Run one local-first sync cycle. Push goes first so optimistic writes
 * reach the server before pull can merge newer remote rows.
 */
export async function runSync (
    db:Sqlite3Db,
    fetchFn:typeof fetch = fetch
):Promise<void> {
    const trackStatus = isLocalFirstActive.value
    if (trackStatus) setSyncSyncing()

    try {
        await pushSync(
            db,
            fetchFn as Parameters<typeof pushSync>[1],
            { trackStatus: false }
        )
        await pullSync(db, fetchFn, { trackStatus: false })
    } catch (err) {
        if (
            err instanceof PullSyncAuthError ||
            err instanceof PushSyncAuthError
        ) {
            throw err
        }
        if (trackStatus) {
            const pending = await getOutboxCount(db).catch(
                () => undefined
            )
            const deadLetters = await getDeadLetterOutboxCount(db).catch(
                () => undefined
            )
            setSyncError(
                err instanceof Error ? err.message : String(err),
                pending,
                deadLetters
            )
        }
        throw err
    }

    if (trackStatus) {
        setSyncDone(
            await getOutboxCount(db),
            await getDeadLetterOutboxCount(db)
        )
    }
}
