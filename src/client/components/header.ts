import { html } from 'htm/preact/index.js'
import { useCallback } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state.js'
import { State } from '../state.js'
import './header.css'

export const Header:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const { user, route } = state

    const handleLogout = useCallback(async () => {
        await State.logout(state)
    }, [])

    return html`
        <header class="app-header">
            <div class="header header-left">
                <h1><a href="/" class="logo">RSSS</a></h1>
                <div>Really Simple Syndication Service</div>
            </div>

            <nav>
                <a
                    href="/about"
                    class="header-link${route.value === '/about' ? ' active' : ''}"
                >
                    About
                </a>
            </nav>

            <div>
                <iframe
                    src="https://github.com/sponsors/nichoth/button"
                    title="Sponsor nichoth"
                    height="32"
                    width="114"
                    style="border: 0; border-radius: 6px;"
                ></iframe>
            </div>

            <div class="header header-right">
                ${user.value && html`
                    <span class="user-handle">
                        <a href="/settings">
                            <code>@${user.value?.handle}</code>
                        </a>
                    </span>
                    <button
                        class="btn btn-small"
                        onClick=${handleLogout}
                    >
                        Logout
                    </button>
                `}
            </div>
        </header>
    `
}
