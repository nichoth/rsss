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

export type FeedSyncStatus =
    | 'inactive'
    | 'updates'
    | 'syncing'
    | 'error'
    | 'synced'

export interface FeedStatusLegend {
    label:string;
    ariaLabel:string;
}

const ARIA_PREFIX = 'Feed sync status: '

export function legendFor (
    status:FeedSyncStatus,
    count:number
):FeedStatusLegend {
    if (status === 'synced') {
        return {
            label: 'up to date',
            ariaLabel: `${ARIA_PREFIX}up to date`
        }
    }

    if (status === 'updates') {
        const text = count === 1 ? '1 update' : `${count} updates`
        return {
            label: text,
            ariaLabel: `${ARIA_PREFIX}${text}`
        }
    }

    if (status === 'syncing') {
        return {
            label: 'updating',
            ariaLabel: `${ARIA_PREFIX}updating`
        }
    }

    if (status === 'error') {
        return {
            label: 'sync failed',
            ariaLabel: ''
        }
    }

    return {
        label: '',
        ariaLabel: `${ARIA_PREFIX}${status}`
    }
}

export const FeedStatus:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    if (!state.user.value) return null

    const status = state.displayedFeedSyncStatus.value
    const count = Object.values(state.feedUpdateCounts.value)
        .reduce((sum, value) => sum + value, 0)
    const error = state.feedSyncError.value ?? 'Feed sync failed'
    const color = DOT_COLORS[status]

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

    const legend = legendFor(status, count)
    const wrapperClass = status === 'syncing' ?
        'feed-status syncing' :
        'feed-status'

    return html`
        <span
            key=${status}
            class=${wrapperClass}
            role="status"
            aria-live="polite"
            aria-label=${legend.ariaLabel}
        >
            ${legend.label ?
                html`<span class="feed-status-legend">${legend.label}</span>` :
                ''}
            <${Dot} color=${color} />
        </span>
    `
}
