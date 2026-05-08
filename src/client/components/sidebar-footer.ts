import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { Button } from './button.js'
import { type AppState, State } from '../state'
import './sidebar-footer.css'

export const SidebarFooter:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { refreshInProgress } = state

    return html`<div class="sidebar-footer">
        <${Button}
            onClick=${() => State.refreshFeeds(state)}
            isSpinning=${refreshInProgress}
        >
            Refresh Feeds
        <//>
        <div class="footer-links">
            <a href="/settings" class="settings-link">
                Settings
            </a>
        </div>
    </div>`
}
