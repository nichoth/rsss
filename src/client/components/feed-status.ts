import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state.js'
import { Dot } from './dot.js'
import './feed-status.css'

export const FeedStatus:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    if (!state.user.value) return null

    const status = state.feedUpdateStatus.value

    return html`
        <span
            class="feed-status"
            role="status"
            aria-live="polite"
        >
            ${status === 'synced' ?
                html`<${Dot} color="green" />${' '}status: synced` :
                html`<${Dot} color="yellow" />${' '}status: <a href="/updates">updates</a>`
            }
        </span>
    `
}
