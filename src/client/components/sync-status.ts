import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import {
    syncStatus,
    syncedAt,
    syncError,
    syncPending,
    syncDeadLetters,
    isLocalFirstActive
} from '../db/sync-status.js'
import { billingStatus } from '../billing-status.js'
import './sync-status.css'

function formatTime (date:Date):string {
    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    })
}

export const SyncStatus:FunctionComponent = function () {
    const active = isLocalFirstActive.value
    const billing = billingStatus.value

    // Free plan: show an online-only indicator with an upgrade CTA.
    // Free users hit the server directly; local-first is paid-only.
    if (billing && !billing.entitled) {
        return html`
            <span
                class="sync-status free"
                aria-label="Online only: free plan requires an internet connection"
                title="Free plan -- requires internet"
            >
                Online only -${' '}
                <a href="/signup">Upgrade</a>
            </span>
        `
    }

    if (!active) return null

    const status = syncStatus.value
    const at = syncedAt.value
    const err = syncError.value
    const pending = syncPending.value
    const deadLetters = syncDeadLetters.value

    let label:string
    let cls:string
    let title:string|undefined
    let a11yLabel:string

    if (status === 'syncing') {
        label = 'Syncing...'
        cls = 'sync-status syncing'
        a11yLabel = label
    } else if (status === 'offline') {
        label = pending > 0 ? `Offline - ${pending} pending` : 'Offline'
        cls = 'sync-status offline'
        a11yLabel = label
    } else if (status === 'error') {
        label = 'Sync error'
        cls = 'sync-status error'
        title = err ?? undefined
        a11yLabel = err ? `${label}: ${err}` : label
    } else if (status === 'warning') {
        label = deadLetters > 0
            ? `Sync warning - ${deadLetters} blocked`
            : 'Sync warning'
        cls = 'sync-status warning'
        title = 'Some local changes stopped retrying after 10 failures'
        a11yLabel = `${label}: ${title}`
    } else {
        label = at ? `Synced ${formatTime(at)}` : 'Synced'
        cls = 'sync-status idle'
        a11yLabel = label
    }

    return html`
        <span
            class=${cls}
            role="status"
            aria-live="polite"
            aria-label=${a11yLabel}
            title=${title}
        >${label}</span>
    `
}
