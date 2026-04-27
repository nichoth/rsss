import { type Signal, signal, batch } from '@preact/signals'
import { billingStatus } from './billing-status.js'

export const syncSubscriptions:Signal<boolean> = signal(false)
export const storeContent:Signal<boolean> = signal(false)

const LS_KEY = 'rsss.localFirst'

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

export function setSyncSubscriptions (v:boolean):void {
    if (v && !billingStatus.value?.entitled) return
    if (!v) {
        batch(() => {
            syncSubscriptions.value = false
            storeContent.value = false
        })
    } else {
        syncSubscriptions.value = true
    }
}
