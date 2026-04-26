import { batch } from '@preact/signals'
import {
    syncSubscriptions,
    setSyncSubscriptions,
    saveLocalFirstSettings
} from '../local-first-settings.js'
import { remoteAdapter } from './remote-adapter.js'
import { createLocalAdapter } from './local-adapter.js'
import {
    openLocalDb,
    OPFSUnavailableError,
    removeOpfsDb
} from './sqlite-init.js'
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
    bootstrapLocalDb
} from './bootstrap.js'
import { pushSync } from './push-sync.js'
import type { DbAdapter } from './types.js'
import type { Sqlite3Db } from './sqlite-init.js'

export { remoteAdapter } from './remote-adapter.js'
export { initSqlite, OPFSUnavailableError } from './sqlite-init.js'
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

let _supportedCache:boolean|null = null

export function isLocalFirstSupported ():boolean {
    if (_supportedCache !== null) return _supportedCache
    _supportedCache = (
        typeof navigator !== 'undefined' &&
        navigator.storage != null &&
        typeof navigator.storage.getDirectory === 'function' &&
        (globalThis as { crossOriginIsolated?:boolean })
            .crossOriginIsolated === true &&
        typeof (globalThis as Record<string, unknown>)
            .FileSystemSyncAccessHandle !== 'undefined'
    )
    return _supportedCache
}

/** Reset the cached support flag (for tests). */
export function _resetSupportedCache ():void {
    _supportedCache = null
}

let _cachedAdapter:DbAdapter|null = null
let _cachedAdapterDid:string|null = null
let _cachedDb:Sqlite3Db|null = null

/**
 * Returns `localAdapter` when the user has opted in AND the browser
 * supports OPFS.  Otherwise returns `remoteAdapter`.
 *
 * Pass `did` only when local-first is active (used to open the DB).
 */
export async function getAdapter (did?:string):Promise<DbAdapter> {
    if (
        syncSubscriptions.value &&
        isLocalFirstSupported() &&
        did &&
        !bootstrapInProgress.value
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
            markLocalTabPrimary()
            return _cachedAdapter
        } catch (err) {
            if (err instanceof OPFSUnavailableError) {
                if (err.message === LOCAL_TAB_LOCK_ERROR) {
                    setLocalTabBlocked()
                }
                return remoteAdapter
            }
            throw err
        }
    }
    return remoteAdapter
}

/**
 * Returns the cached local DB if local-first is active,
 * null otherwise. Useful for pull/push-sync operations.
 */
export function getLocalDb (did?:string):Sqlite3Db|null {
    if (
        syncSubscriptions.value &&
        isLocalFirstSupported() &&
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
}

/**
 * Disable local-first for `did`:
 * 1. Best-effort pushSync drain (skipped if offline).
 * 2. Removes the OPFS file.
 * 3. Clears in-memory adapter/DB caches.
 * 4. Flips syncSubscriptions to false and persists.
 */
export async function disableLocalFirst (
    did:string,
    fetchFn:typeof fetch = fetch
):Promise<void> {
    const db = getBootstrappedDb() ?? _cachedDb
    if (db && navigator.onLine) {
        try {
            await pushSync(db, fetchFn as Parameters<typeof pushSync>[1])
        } catch (_) {
            // best-effort — ignore errors
        }
    }
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
 * re-bootstrap without changing the toggle.
 */
export async function resetLocalFirst (
    did:string,
    fetchFn:typeof fetch = fetch
):Promise<void> {
    const db = getBootstrappedDb() ?? _cachedDb
    if (db && navigator.onLine) {
        try {
            await pushSync(db, fetchFn as Parameters<typeof pushSync>[1])
        } catch (_) {
            // best-effort
        }
    }
    clearBootstrappedDb()
    _resetAdapterCache()
    markLocalTabReleased()
    await removeOpfsDb(did)
    await bootstrapLocalDb(did, fetchFn)
}
