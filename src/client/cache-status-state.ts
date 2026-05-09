/**
 * Module-level signals for the local-cache health indicator shown in
 * the header. The compute step queries the local DB; recomputation is
 * triggered explicitly from places that mutate items, policies, or
 * settings (see callers in state.ts and local-first-settings.ts).
 */
import { type Signal, signal, batch } from '@preact/signals'
import Debug from '@substrate-system/debug'
import { getBootstrappedDb, getLocalDb } from './db/index.js'
import {
    computeCacheStatus,
    type CacheStatusSnapshot
} from './db/cache-status.js'
import { billingStatus } from './billing-status.js'
import { isLocalFirstActive } from './db/sync-status.js'

const debug = Debug('rsss:cache-status')

export type { CacheStatusSnapshot, ItemToCache } from './db/cache-status.js'

export const cacheStatus:Signal<CacheStatusSnapshot|null> = signal(null)
export const cacheActionInProgress:Signal<boolean> = signal(false)
export const cacheActionProgress:Signal<{
    current:number;
    total:number;
}|null> = signal(null)
export const cacheActionError:Signal<string|null> = signal(null)

let recomputeToken = 0

export function resetCacheStatus ():void {
    batch(() => {
        cacheStatus.value = null
        cacheActionInProgress.value = false
        cacheActionProgress.value = null
        cacheActionError.value = null
    })
}

/**
 * Recompute the cache snapshot for the user's currently selected feed
 * (or all feeds if none is selected). Free / non-paid users have no
 * local cache, so the snapshot is cleared.
 */
const EMPTY_SNAPSHOT:CacheStatusSnapshot = {
    uncachedCount: 0,
    totalCount: 0,
    itemsToCache: []
}

export async function recomputeCacheStatus (state:{
    user:Signal<{ did:string }|null>
    selectedFeedId:Signal<number|null>
}):Promise<void> {
    const billing = billingStatus.value
    if (!billing || !billing.entitled) {
        if (cacheStatus.value !== null) cacheStatus.value = null
        return
    }

    const did = state.user.value?.did
    if (!did) {
        cacheStatus.value = EMPTY_SNAPSHOT
        return
    }

    const db = getBootstrappedDb() ?? getLocalDb(did)
    if (!db || !isLocalFirstActive.value) {
        // Paid but no local DB / sync off: nothing locally to cache, so
        // callers render a neutral or hidden state instead of success.
        cacheStatus.value = EMPTY_SNAPSHOT
        return
    }

    const token = ++recomputeToken
    const feedId = state.selectedFeedId.value
    try {
        const snapshot = await computeCacheStatus(db, { feedId })
        if (token !== recomputeToken) return
        cacheStatus.value = snapshot
    } catch (err) {
        debug('recomputeCacheStatus error:', err)
    }
}
