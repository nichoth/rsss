import { type Signal, signal, batch, effect } from '@preact/signals'
import { billingStatus } from './billing-status.js'

export type CacheMode = 'text' | 'text_images'

const DEFAULT_CACHE_MODE:CacheMode = 'text_images'
const DEFAULT_MAX_SIZE_BYTES = 50_000_000
const DEFAULT_MAX_AGE_SECONDS = 30 * 86400
const DEFAULT_ACCOUNT_MAX_SIZE_BYTES = 500_000_000

export const syncSubscriptions:Signal<boolean> = signal(false)
export const storeContent:Signal<boolean> = signal(false)
export const pendingSyncSubscriptions:Signal<boolean> = signal(false)
export const defaultCacheMode:Signal<CacheMode> =
    signal(DEFAULT_CACHE_MODE)
export const defaultMaxSizeBytes:Signal<number> =
    signal(DEFAULT_MAX_SIZE_BYTES)
export const defaultMaxAgeSeconds:Signal<number> =
    signal(DEFAULT_MAX_AGE_SECONDS)
export const defaultAccountMaxSizeBytes:Signal<number> =
    signal(DEFAULT_ACCOUNT_MAX_SIZE_BYTES)

const LS_KEY = 'rsss.localFirst'
export type SyncSubscriptionsResult = 'applied'|'pending'|'blocked'

export function loadLocalFirstSettings ():void {
    try {
        const raw = localStorage.getItem(LS_KEY)
        if (!raw) return
        const parsed = JSON.parse(raw)
        batch(() => {
            syncSubscriptions.value = Boolean(parsed.syncSubscriptions)
            storeContent.value = Boolean(parsed.storeContent)
            const mode = parsed.defaultCacheMode
            defaultCacheMode.value = (
                mode === 'text' || mode === 'text_images' ?
                    mode :
                    DEFAULT_CACHE_MODE
            )
            const size = parsed.defaultMaxSizeBytes
            defaultMaxSizeBytes.value = (
                typeof size === 'number' && isFinite(size) ?
                    size :
                    DEFAULT_MAX_SIZE_BYTES
            )
            const age = parsed.defaultMaxAgeSeconds
            defaultMaxAgeSeconds.value = (
                typeof age === 'number' && isFinite(age) ?
                    age :
                    DEFAULT_MAX_AGE_SECONDS
            )
            const acctSize = parsed.defaultAccountMaxSizeBytes
            defaultAccountMaxSizeBytes.value = (
                typeof acctSize === 'number' && isFinite(acctSize) ?
                    acctSize :
                    DEFAULT_ACCOUNT_MAX_SIZE_BYTES
            )
        })
    } catch {
        // ignore corrupt storage
    }
}

export function saveLocalFirstSettings ():void {
    localStorage.setItem(LS_KEY, JSON.stringify({
        syncSubscriptions: syncSubscriptions.value,
        storeContent: storeContent.value,
        defaultCacheMode: defaultCacheMode.value,
        defaultMaxSizeBytes: defaultMaxSizeBytes.value,
        defaultMaxAgeSeconds: defaultMaxAgeSeconds.value,
        defaultAccountMaxSizeBytes: defaultAccountMaxSizeBytes.value
    }))
}

export function setSyncSubscriptions (v:boolean):SyncSubscriptionsResult {
    if (!v) {
        batch(() => {
            pendingSyncSubscriptions.value = false
            syncSubscriptions.value = false
            storeContent.value = false
        })
        return 'applied'
    }

    const billing = billingStatus.value
    if (billing === null) {
        pendingSyncSubscriptions.value = true
        return 'pending'
    }
    if (!billing.entitled) {
        pendingSyncSubscriptions.value = false
        return 'blocked'
    }

    batch(() => {
        pendingSyncSubscriptions.value = false
        syncSubscriptions.value = true
    })
    return 'applied'
}

effect(() => {
    if (!pendingSyncSubscriptions.value) return
    const billing = billingStatus.value
    if (billing === null) return

    if (!billing.entitled) {
        pendingSyncSubscriptions.value = false
        return
    }

    batch(() => {
        pendingSyncSubscriptions.value = false
        syncSubscriptions.value = true
    })
    saveLocalFirstSettings()
})
