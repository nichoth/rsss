import { syncSubscriptions } from '../local-first-settings.js'
import { remoteAdapter } from './remote-adapter.js'
import { createLocalAdapter } from './local-adapter.js'
import { openLocalDb, OPFSUnavailableError } from './sqlite-init.js'
import type { DbAdapter } from './types.js'

export { remoteAdapter } from './remote-adapter.js'
export { initSqlite, OPFSUnavailableError } from './sqlite-init.js'
export type { Sqlite3, Sqlite3Db } from './sqlite-init.js'
export type * from './types.js'

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

/**
 * Returns `localAdapter` when the user has opted in AND the browser
 * supports OPFS.  Otherwise returns `remoteAdapter`.
 *
 * Pass `did` only when local-first is active (used to open the DB).
 */
export async function getAdapter (did?:string):Promise<DbAdapter> {
    if (syncSubscriptions.value && isLocalFirstSupported() && did) {
        if (_cachedAdapter && _cachedAdapterDid === did) {
            return _cachedAdapter
        }
        try {
            const db = await openLocalDb(did)
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

/** Reset adapter cache (for tests). */
export function _resetAdapterCache ():void {
    _cachedAdapter = null
    _cachedAdapterDid = null
}
