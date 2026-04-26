import { type Signal, signal, batch } from '@preact/signals'
import {
    setSyncSubscriptions,
    saveLocalFirstSettings
} from '../local-first-settings.js'
import { openLocalDb, removeOpfsDb } from './sqlite-init.js'
import { pullSync } from './pull-sync.js'
import {
    isLocalTabBlocked,
    LOCAL_TAB_LOCK_ERROR,
    localTabLockError,
    markLocalTabPrimary,
    setLocalTabBlocked,
    startTabCoordination
} from './tab-coordination.js'
import type { Sqlite3Db } from './sqlite-init.js'

export const bootstrapInProgress:Signal<boolean> = signal(false)
export const bootstrapFeedsCount:Signal<number> = signal(0)
export const bootstrapItemsCount:Signal<number> = signal(0)
export const bootstrapError:Signal<string|null> = signal(null)

/** The open DB after a successful bootstrap (cleared on disable). */
let _bootstrappedDb:Sqlite3Db|null = null

export function getBootstrappedDb ():Sqlite3Db|null {
    return _bootstrappedDb
}

export function clearBootstrappedDb ():void {
    _bootstrappedDb = null
}

/**
 * Run the first-time (or re-) bootstrap for `did`:
 * 1. Opens (or reuses) the local OPFS DB.
 * 2. Runs a full pullSync, reporting progress via signals.
 * 3. On failure: reverts syncSubscriptions to false, removes the OPFS file.
 */
export async function bootstrapLocalDb (
    did:string,
    fetchFn:typeof fetch = fetch
):Promise<void> {
    batch(() => {
        bootstrapInProgress.value = true
        bootstrapFeedsCount.value = 0
        bootstrapItemsCount.value = 0
        bootstrapError.value = null
    })

    try {
        startTabCoordination()
        if (isLocalTabBlocked()) {
            throw new Error(localTabLockError.value ?? (
                LOCAL_TAB_LOCK_ERROR
            ))
        }
        const db = await openLocalDb(did)

        await pullSync(db, fetchFn, {
            onFeedUpserted: (count) => {
                bootstrapFeedsCount.value = count
            },
            onItemUpserted: (count) => {
                bootstrapItemsCount.value = count
            }
        })

        _bootstrappedDb = db
        markLocalTabPrimary()
        bootstrapInProgress.value = false
    } catch (err) {
        if (err instanceof Error && err.message === LOCAL_TAB_LOCK_ERROR) {
            setLocalTabBlocked()
        }
        const msg = err instanceof Error ? err.message : String(err)
        batch(() => {
            bootstrapError.value = msg
            bootstrapInProgress.value = false
        })
        setSyncSubscriptions(false)
        saveLocalFirstSettings()
        await removeOpfsDb(did)
    }
}
