import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import {
    syncStatus,
    syncedAt,
    syncError,
    syncPending,
    isLocalFirstActive
} from '../db/sync-status.js'
import './sync-status.css'

function formatTime (date:Date):string {
    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    })
}

export const SyncStatus:FunctionComponent = function () {
    const active = isLocalFirstActive.value
    if (!active) return null

    const status = syncStatus.value
    const at = syncedAt.value
    const err = syncError.value
    const pending = syncPending.value

    let label:string
    let cls:string
    let title:string|undefined

    if (status === 'syncing') {
        label = 'Syncing...'
        cls = 'sync-status syncing'
    } else if (status === 'offline') {
        label = pending > 0 ? `Offline – ${pending} pending` : 'Offline'
        cls = 'sync-status offline'
    } else if (status === 'error') {
        label = 'Sync error'
        cls = 'sync-status error'
        title = err ?? undefined
    } else {
        label = at ? `Synced ${formatTime(at)}` : 'Synced'
        cls = 'sync-status idle'
    }

    return html`
        <span
            class=${cls}
            title=${title}
        >${label}</span>
    `
}
