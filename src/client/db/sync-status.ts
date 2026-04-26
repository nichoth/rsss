import { type Signal, signal, batch } from '@preact/signals'

export type SyncStatusType =
    'idle' |
    'syncing' |
    'error' |
    'offline' |
    'warning'

export const syncStatus:Signal<SyncStatusType> = signal('idle')
export const syncedAt:Signal<Date|null> = signal(null)
export const syncError:Signal<string|null> = signal(null)
export const syncPending:Signal<number> = signal(0)
export const syncDeadLetters:Signal<number> = signal(0)
export const isLocalFirstActive:Signal<boolean> = signal(false)

export function setSyncSyncing ():void {
    batch(() => {
        syncStatus.value = 'syncing'
        syncError.value = null
    })
}

export function setSyncDone (
    pending:number,
    deadLetters = syncDeadLetters.value
):void {
    batch(() => {
        syncStatus.value = deadLetters > 0
            ? 'warning'
            : navigator.onLine ? 'idle' : 'offline'
        syncedAt.value = new Date()
        syncPending.value = pending
        syncDeadLetters.value = deadLetters
        syncError.value = null
    })
}

export function setSyncError (
    msg:string,
    pending = syncPending.value,
    deadLetters = syncDeadLetters.value
):void {
    batch(() => {
        syncStatus.value = 'error'
        syncError.value = msg
        syncPending.value = pending
        syncDeadLetters.value = deadLetters
    })
}

export function setSyncOffline (pending:number):void {
    batch(() => {
        syncStatus.value = 'offline'
        syncPending.value = pending
    })
}

export function updateOnlineStatus ():void {
    if (!isLocalFirstActive.value) return
    if (!navigator.onLine) {
        syncStatus.value = 'offline'
    } else if (syncStatus.value === 'offline') {
        syncStatus.value = 'idle'
    }
}
