import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state.js'
import { Dot } from './dot.js'
import './feed-status.css'

const DOT_COLORS = {
    inactive: 'gray',
    updates: 'blue',
    syncing: 'yellow',
    error: 'red',
    synced: 'green'
} as const

export const FeedStatus:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    if (!state.user.value) return null

    const status = state.feedSyncStatus.value
    const count = Object.values(state.feedUpdateCounts.value)
        .reduce((sum, value) => sum + value, 0)
    const error = state.feedSyncError.value ?? 'Feed sync failed'
    const color = DOT_COLORS[status]
    const label = status === 'updates' && count > 0 ?
        `Feed sync status: ${count} updates` :
        `Feed sync status: ${status}`

    if (status === 'error') {
        return html`
            <span
                key=${status}
                class="feed-status"
                role="status"
                aria-live="polite"
                aria-label=${`Feed sync error: ${error}`}
                title=${error}
            >
                <${Dot} color=${color} />
                sync failed
            </span>
        `
    }

    return html`
        <span
            key=${status}
            class="feed-status"
            role="status"
            aria-live="polite"
            aria-label=${label}
        >
            <${Dot} color=${color} />
            ${status === 'updates' && count > 0 ? count : ''}
        </span>
    `
}
