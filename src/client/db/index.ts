import { syncSubscriptions } from '../local-first-settings.js'
import { remoteAdapter } from './remote-adapter.js'
import { createLocalAdapter } from './local-adapter.js'
import { openLocalDb, OPFSUnavailableError } from './sqlite-init.js'
import { bootstrapInProgress, getBootstrappedDb } from './bootstrap.js'
import type { DbAdapter } from './types.js'
import type { Sqlite3Db } from './sqlite-init.js'

export { remoteAdapter } from './remote-adapter.js'
export { initSqlite, OPFSUnavailableError } from './sqlite-init.js'
export type { Sqlite3, Sqlite3Db } from './sqlite-init.js'
export type * from './types.js'
export {
    bootstrapLocalDb,
    bootstrapInProgress,
    bootstrapFeedsCount,
    bootstrapItemsCount,
    bootstrapError,
    clearBootstrappedDb
} from './bootstrap.js'

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
            return _cachedAdapter
        } catch (err) {
            if (err instanceof OPFSUnavailableError) {
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
