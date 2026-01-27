import { html } from 'htm/preact/index.js'
import { useCallback } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state.js'
import { StatusIndicator } from './status-indicator.js'
import { State } from '../state.js'
import './header.css'

export const Header:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const { isOnline, user, route } = state

    const handleLogout = useCallback(async () => {
        await State.logout(state)
    }, [])

    return html`
        <header class="app-header">
            <div class="header header-left">
                <h1>RSSS</h1>
                <div>Really Simple Syndication Service</div>
            </div>

            <div>
                <${StatusIndicator}
                    type=${isOnline.value ? 'online' : 'offline'}
                    title=${isOnline.value ? 'Online' : 'Offline'}
                >${isOnline.value ? 'online' : 'offline'}<//>
            </div>

            <div class="header header-right">
                <a
                    href="/about"
                    class="header-link${route.value === '/about' ? ' active' : ''}"
                >About</a>
                <span class="user-handle">@${user.value?.handle}</span>
                <button class="btn btn-small" onClick=${handleLogout}>
                    Logout
                </button>
            </div>
        </header>
    `
}
