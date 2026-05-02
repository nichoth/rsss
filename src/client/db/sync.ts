import { describeLocalDbError } from './sqlite-init.js'
import {
    PullSyncAuthError,
    SyncBillingError,
    pullSync
} from './pull-sync.js'
import {
    getDeadLetterOutboxCount,
    getOutboxCount,
    PushSyncAuthError,
    PushSyncBillingError,
    pushSync
} from './push-sync.js'
import {
    evictByMaxAge,
    evictByFeedSizeCap,
    evictByAccountSizeCap
} from './cache-eviction.js'
import {
    isLocalFirstActive,
    setSyncDone,
    setSyncError,
    setSyncSyncing
} from './sync-status.js'
import type { Sqlite3Db } from './sqlite-init.js'

const inFlightSyncs = new WeakMap<Sqlite3Db, Promise<void>>()
const inFlightAbortControllers = new WeakMap<Sqlite3Db, AbortController>()
const disableInProgress = new WeakSet<Sqlite3Db>()

export class SyncCancelledError extends Error {
    constructor () {
        super('local-first sync cancelled')
        this.name = 'SyncCancelledError'
    }
}

export function beginLocalFirstDisable (db:Sqlite3Db|null):void {
    if (!db) return
    disableInProgress.add(db)
    inFlightAbortControllers.get(db)?.abort(new SyncCancelledError())
}

export function endLocalFirstDisable (db:Sqlite3Db|null):void {
    if (!db) return
    disableInProgress.delete(db)
}

function isAbortError (err:unknown):boolean {
    return err instanceof DOMException && err.name === 'AbortError'
}

function isCancellation (db:Sqlite3Db, err:unknown):boolean {
    return (
        err instanceof SyncCancelledError ||
        isAbortError(err) ||
        disableInProgress.has(db)
    )
}

function throwIfDisabling (db:Sqlite3Db):void {
    if (disableInProgress.has(db)) throw new SyncCancelledError()
}

function createAbortableFetch (
    db:Sqlite3Db,
    fetchFn:typeof fetch,
    controller:AbortController
):typeof fetch {
    return async (url, init) => {
        throwIfDisabling(db)
        if (controller.signal.aborted) throw new SyncCancelledError()

        return fetchFn(url, {
            ...init,
            signal: controller.signal
        })
    }
}

/**
 * Run one local-first sync cycle. Push goes first so optimistic writes
 * reach the server before pull can merge newer remote rows.
 * Invariant: getPendingOutboxRefs is called after pushSync resolves.
 */
export async function runSync (
    db:Sqlite3Db,
    fetchFn:typeof fetch = fetch
):Promise<void> {
    if (disableInProgress.has(db)) return

    const inFlight = inFlightSyncs.get(db)
    if (inFlight) return inFlight

    const syncPromise = runSyncCycle(db, fetchFn).finally(() => {
        if (inFlightSyncs.get(db) === syncPromise) {
            inFlightSyncs.delete(db)
        }
        inFlightAbortControllers.delete(db)
    })
    inFlightSyncs.set(db, syncPromise)
    return syncPromise
}

async function runSyncCycle (
    db:Sqlite3Db,
    fetchFn:typeof fetch
):Promise<void> {
    const controller = new AbortController()
    inFlightAbortControllers.set(db, controller)
    const abortableFetch = createAbortableFetch(db, fetchFn, controller)
    const trackStatus = isLocalFirstActive.value &&
        !disableInProgress.has(db)
    if (trackStatus) setSyncSyncing()

    try {
        throwIfDisabling(db)
        await pushSync(
            db,
            abortableFetch as Parameters<typeof pushSync>[1],
            { trackStatus: false }
        )
        throwIfDisabling(db)
        await pullSync(db, abortableFetch, { trackStatus: false })
        throwIfDisabling(db)
        await evictByMaxAge(db).catch(() => {})
        await evictByFeedSizeCap(db).catch(() => {})
        await evictByAccountSizeCap(db).catch(() => {})
    } catch (err) {
        if (isCancellation(db, err)) return
        if (
            err instanceof PullSyncAuthError ||
            err instanceof PushSyncAuthError ||
            err instanceof SyncBillingError ||
            err instanceof PushSyncBillingError
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
                describeLocalDbError(err),
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
