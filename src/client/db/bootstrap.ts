import { type Signal, signal, batch } from '@preact/signals'
import {
    setSyncSubscriptions,
    saveLocalFirstSettings
} from '../local-first-settings.js'
import {
    LocalDbOpenError,
    openLocalDb,
    removeOpfsDb
} from './sqlite-init.js'
import { pullSync } from './pull-sync.js'
import {
    acquireLocalTabLock,
    LOCAL_TAB_LOCK_ERROR,
    localTabLockError,
    releaseLocalTabLock,
    setLocalTabBlocked
} from './tab-coordination.js'
import { closeDb } from './local-db.js'
import type { Sqlite3Db } from './sqlite-init.js'

export const bootstrapInProgress:Signal<boolean> = signal(false)
export const bootstrapFeedsCount:Signal<number> = signal(0)
export const bootstrapItemsCount:Signal<number> = signal(0)
export const bootstrapError:Signal<string|null> = signal(null)
export const bootstrapRetryAvailable:Signal<boolean> = signal(false)

/** The open DB after a successful bootstrap (cleared on disable). */
let _bootstrappedDb:Sqlite3Db|null = null
const bootstrapFailureCleanups = new Set<() => void>()

export function getBootstrappedDb ():Sqlite3Db|null {
    return _bootstrappedDb
}

export function clearBootstrappedDb ():void {
    _bootstrappedDb = null
}

export function addBootstrapFailureCleanup (
    fn:() => void
):() => void {
    bootstrapFailureCleanups.add(fn)
    return () => {
        bootstrapFailureCleanups.delete(fn)
    }
}

function runBootstrapFailureCleanups ():void {
    for (const cleanup of bootstrapFailureCleanups) {
        cleanup()
    }
}

export interface BootstrapLocalDbOptions {
    confirmTerminalReset?:(message:string) => boolean|Promise<boolean>
}

function isTransientBootstrapError (err:unknown):boolean {
    if (err instanceof LocalDbOpenError) {
        return (
            err.category === 'locked' ||
            err.category === 'unavailable' ||
            err.category === 'unknown'
        )
    }

    if (err instanceof DOMException && err.name === 'AbortError') {
        return true
    }

    if (err instanceof TypeError) return true

    const msg = err instanceof Error ? err.message : String(err)
    return /server returned 5\d\d|failed to fetch|network|abort/i.test(msg)
}

/**
 * Run the first-time (or re-) bootstrap for `did`:
 * 1. Opens (or reuses) the local OPFS DB.
 * 2. Runs a full pullSync, reporting progress via signals.
 * 3. On transient failure: leaves settings and local data for retry.
 * 4. On terminal failure: wipes local data only after confirmation.
 */
export async function bootstrapLocalDb (
    did:string,
    fetchFn:typeof fetch = fetch,
    opts:BootstrapLocalDbOptions = {}
):Promise<void> {
    let openedDb:Sqlite3Db|null = null
    let lockAcquired = false
    batch(() => {
        bootstrapInProgress.value = true
        bootstrapFeedsCount.value = 0
        bootstrapItemsCount.value = 0
        bootstrapError.value = null
        bootstrapRetryAvailable.value = false
    })

    try {
        lockAcquired = await acquireLocalTabLock()
        if (!lockAcquired) {
            throw new Error(localTabLockError.value ?? (
                LOCAL_TAB_LOCK_ERROR
            ))
        }
        const db = await openLocalDb(did)
        openedDb = db

        await pullSync(db, fetchFn, {
            onFeedPage: (count) => {
                bootstrapFeedsCount.value += count
            },
            onItemPage: (count) => {
                bootstrapItemsCount.value += count
            }
        })

        _bootstrappedDb = db
        openedDb = null
        batch(() => {
            bootstrapInProgress.value = false
            bootstrapRetryAvailable.value = false
        })
    } catch (err) {
        if (err instanceof Error && err.message === LOCAL_TAB_LOCK_ERROR) {
            setLocalTabBlocked()
        }
        const msg = err instanceof Error ? err.message : String(err)
        const isTransient = isTransientBootstrapError(err)
        batch(() => {
            bootstrapError.value = msg
            bootstrapInProgress.value = false
            bootstrapRetryAvailable.value = isTransient
        })
        _bootstrappedDb = null
        await closeDb(openedDb)
        if (lockAcquired) {
            await releaseLocalTabLock()
        }

        if (isTransient) return

        const confirmed = opts.confirmTerminalReset ?
            await opts.confirmTerminalReset(msg) :
            false
        if (!confirmed) return

        runBootstrapFailureCleanups()
        setSyncSubscriptions(false)
        saveLocalFirstSettings()
        await removeOpfsDb(did)
    }
}
