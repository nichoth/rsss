import { type Signal, signal, batch, effect } from '@preact/signals'
import { billingStatus } from './billing-status.js'

export const syncSubscriptions:Signal<boolean> = signal(false)
export const storeContent:Signal<boolean> = signal(false)
export const pendingSyncSubscriptions:Signal<boolean> = signal(false)

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
        })
    } catch {
        // ignore corrupt storage
    }
}

export function saveLocalFirstSettings ():void {
    localStorage.setItem(LS_KEY, JSON.stringify({
        syncSubscriptions: syncSubscriptions.value,
        storeContent: storeContent.value
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
