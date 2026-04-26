import { batch, signal } from '@preact/signals'
import {
    syncSubscriptions,
    setSyncSubscriptions,
    saveLocalFirstSettings
} from '../local-first-settings.js'
import { remoteAdapter } from './remote-adapter.js'
import { createLocalAdapter } from './local-adapter.js'
import {
    openLocalDb,
    classifyLocalDbError,
    LocalDbOpenError,
    OPFSUnavailableError,
    removeOpfsDb,
    probeOpfsSupport
} from './sqlite-init.js'
import { closeDb } from './local-db.js'
import {
    isLocalTabBlocked,
    LOCAL_TAB_LOCK_ERROR,
    markLocalTabPrimary,
    markLocalTabReleased,
    setLocalTabBlocked,
    startTabCoordination
} from './tab-coordination.js'
import {
    bootstrapInProgress,
    getBootstrappedDb,
    clearBootstrappedDb,
    addBootstrapFailureCleanup,
    bootstrapLocalDb
} from './bootstrap.js'
import { pushSync, getOutboxCount } from './push-sync.js'
import type { DbAdapter, Item } from './types.js'
import type {
    LocalDbErrorCategory,
    Sqlite3Db
} from './sqlite-init.js'

export { remoteAdapter } from './remote-adapter.js'
export {
    initSqlite,
    classifyLocalDbError,
    LocalDbOpenError,
    OPFSUnavailableError
} from './sqlite-init.js'
export {
    getLocalTabLockError,
    localTabLockError,
    startTabCoordination
} from './tab-coordination.js'
export type { Sqlite3, Sqlite3Db } from './sqlite-init.js'
export type * from './types.js'
export {
    bootstrapLocalDb,
    bootstrapInProgress,
    bootstrapFeedsCount,
    bootstrapItemsCount,
    bootstrapError,
    getBootstrappedDb,
    clearBootstrappedDb
} from './bootstrap.js'
export { getOutboxCount } from './push-sync.js'
export { purgeStoredContent } from './content-storage.js'

export const localFirstSupported = signal(false)

export interface LocalDbErrorState {
    category:LocalDbErrorCategory
    message:string
    canReset:boolean
}

export const localDbError = signal<LocalDbErrorState|null>(null)

let _supportedCache:boolean|null = null
let _supportedPromise:Promise<boolean>|null = null

export async function isLocalFirstSupported ():Promise<boolean> {
    if (_supportedCache !== null) return _supportedCache
    if (_supportedPromise) return _supportedPromise

    _supportedPromise = probeOpfsSupport()
        .then((supported) => {
            _supportedCache = supported
            localFirstSupported.value = supported
            return supported
        })

    return _supportedPromise
}

/** Reset the cached support flag (for tests). */
export function _resetSupportedCache ():void {
    _supportedCache = null
    _supportedPromise = null
    localFirstSupported.value = false
}

let _cachedAdapter:DbAdapter|null = null
let _cachedAdapterDid:string|null = null
let _cachedDb:Sqlite3Db|null = null

function localDbErrorMessage (
    category:LocalDbErrorCategory,
    err:unknown
):string {
    if (category === 'quota') {
        return (
            'Local storage is full. Free up space or reset local data, ' +
            'then try again.'
        )
    }
    if (category === 'corruption') {
        return (
            'Local storage could not be read. Reset local data to rebuild ' +
            'the on-device database.'
        )
    }
    if (category === 'locked') return LOCAL_TAB_LOCK_ERROR
    if (category === 'unavailable') {
        return 'Local storage is not supported in this browser.'
    }

    const detail = err instanceof Error ? `: ${err.message}` : ''
    return `Local storage could not be opened${detail}`
}

function reportLocalDbError (err:unknown):LocalDbErrorCategory {
    const category = classifyLocalDbError(err)
    localDbError.value = {
        category,
        message: err instanceof LocalDbOpenError ?
            err.message :
            localDbErrorMessage(category, err),
        canReset: category === 'corruption' || category === 'unknown'
    }
    return category
}

export class LocalFirstSyncFailureError extends Error {
    pending:number

    constructor (pending:number, cause?:unknown) {
        const detail = cause instanceof Error ? `: ${cause.message}` : ''
        super(
            'Unable to upload pending local changes before deleting ' +
            `local data${detail}`
        )
        this.name = 'LocalFirstSyncFailureError'
        this.pending = pending
    }
}

interface ResetLocalFirstOptions {
    allowDataLossOnSyncFailure?:boolean
}

/**
 * Returns `localAdapter` when the user has opted in AND the browser
 * supports OPFS.  Otherwise returns `remoteAdapter`.
 *
 * Pass `did` only when local-first is active (used to open the DB).
 */
export async function getAdapter (did?:string):Promise<DbAdapter> {
    if (
        syncSubscriptions.value &&
        did &&
        !bootstrapInProgress.value &&
        await isLocalFirstSupported()
    ) {
        startTabCoordination()
        if (isLocalTabBlocked()) {
            return remoteAdapter
        }
        if (_cachedAdapter && _cachedAdapterDid === did) {
            return _cachedAdapter
        }
        // Use the DB opened by bootstrap if available; otherwise open it.
        const bootstrapped = getBootstrappedDb()
        try {
            const db = bootstrapped ?? await openLocalDb(did)
            _cachedDb = db
            _cachedAdapter = createLocalAdapter(db)
            _cachedAdapterDid = did
            localDbError.value = null
            markLocalTabPrimary()
            return _cachedAdapter
        } catch (err) {
            const category = reportLocalDbError(err)
            if (
                err instanceof OPFSUnavailableError ||
                category === 'unavailable' ||
                category === 'locked'
            ) {
                if (category === 'locked') setLocalTabBlocked()
                return remoteAdapter
            }
            return remoteAdapter
        }
    }
    return remoteAdapter
}

export async function getRemoteItemByRoute (
    itemRoute:string
):Promise<Item|null> {
    return remoteAdapter.getItemByRoute(itemRoute)
}

/**
 * Returns the cached local DB if local-first is active,
 * null otherwise. Useful for pull/push-sync operations.
 */
export function getLocalDb (did?:string):Sqlite3Db|null {
    if (
        syncSubscriptions.value &&
        did &&
        _cachedAdapterDid === did
    ) {
        return _cachedDb
    }
    return null
}

/** Reset adapter cache (for tests). */
export function _resetAdapterCache ():void {
    _cachedAdapter = null
    _cachedAdapterDid = null
    _cachedDb = null
    localDbError.value = null
}

addBootstrapFailureCleanup(() => {
    _resetAdapterCache()
    markLocalTabReleased()
})

async function pushPendingWritesBeforeRemoval (
    db:Sqlite3Db|null,
    fetchFn:typeof fetch
):Promise<void> {
    if (!db || !navigator.onLine) return

    try {
        await pushSync(db, fetchFn as Parameters<typeof pushSync>[1])
    } catch (err) {
        throw new LocalFirstSyncFailureError(await getOutboxCount(db), err)
    }

    const pending = await getOutboxCount(db)
    if (pending > 0) {
        throw new LocalFirstSyncFailureError(pending)
    }
}

/**
 * Disable local-first for `did`:
 * 1. Drain pending writes with pushSync (skipped if offline).
 * 2. Removes the OPFS file.
 * 3. Clears in-memory adapter/DB caches.
 * 4. Flips syncSubscriptions to false and persists.
 */
export async function disableLocalFirst (
    did:string,
    fetchFn:typeof fetch = fetch
):Promise<void> {
    const db = getBootstrappedDb() ?? _cachedDb
    await pushPendingWritesBeforeRemoval(db, fetchFn)
    await closeDb(db)
    clearBootstrappedDb()
    _resetAdapterCache()
    markLocalTabReleased()
    await removeOpfsDb(did)
    batch(() => {
        setSyncSubscriptions(false)
    })
    saveLocalFirstSettings()
}

/**
 * Reset local data for `did`: wipe the OPFS file and immediately
 * re-bootstrap without changing the toggle. A failed pre-reset push
 * aborts unless the caller explicitly accepts local data loss.
 */
export async function resetLocalFirst (
    did:string,
    fetchFn:typeof fetch = fetch,
    options:ResetLocalFirstOptions = {}
):Promise<void> {
    const db = getBootstrappedDb() ?? _cachedDb
    try {
        await pushPendingWritesBeforeRemoval(db, fetchFn)
    } catch (err) {
        if (!options.allowDataLossOnSyncFailure) throw err
    }
    await closeDb(db)
    clearBootstrappedDb()
    _resetAdapterCache()
    markLocalTabReleased()
    await removeOpfsDb(did)
    await bootstrapLocalDb(did, fetchFn)
}
