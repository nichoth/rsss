import { html } from 'htm/preact/index.js'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { HamburgerTwo } from '@substrate-system/hamburger-two'
import { type AppState } from '../state.js'
import { State } from '../state.js'
import { SyncStatus } from './sync-status.js'
import { FeedStatus } from './feed-status.js'
import { UserIcon } from './user-icon.js'
import './header.css'

HamburgerTwo.define()

export const Header:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const { user, route } = state
    const [menuOpen, setMenuOpen] = useState(false)
    const hamburgerRef = useRef<HTMLElement>(null)

    const handleLogout = useCallback(async () => {
        await State.logout(state)
    }, [])

    useEffect(() => {
        const el = hamburgerRef.current
        if (!el) return

        const onOpen = () => setMenuOpen(true)
        const onClose = () => setMenuOpen(false)

        el.addEventListener(
            HamburgerTwo.event('open'),
            onOpen
        )
        el.addEventListener(
            HamburgerTwo.event('close'),
            onClose
        )

        return () => {
            el.removeEventListener(
                HamburgerTwo.event('open'),
                onOpen
            )
            el.removeEventListener(
                HamburgerTwo.event('close'),
                onClose
            )
        }
    }, [])

    // close menu on route change
    useEffect(() => {
        if (!menuOpen) return
        setMenuOpen(false)
        const el = hamburgerRef.current as
            (HamburgerTwo | null)
        if (el) el.isOpen = false
    }, [route.value])

    return html`
        <header class="app-header">
            <div class="header header-left">
                <h1>
                    <a href="/" class="logo">RSSS</a>
                </h1>
                <div class="fullname">
                    Really Simple Syndication Service
                </div>
            </div>

            <nav class="desktop-nav">
                <a
                    href="/about"
                    class="header-link${
                        route.value === '/about' ?
                            ' active' :
                            ''
                    }"
                >
                    About
                </a>
            </nav>

            <div class="header header-right desktop-nav">
                <${SyncStatus} />
                <${FeedStatus} state=${state} />
                ${user.value && html`
                    <button
                        class="btn btn-small"
                        onClick=${handleLogout}
                    >
                        Logout
                    </button>
                `}
                <${UserIcon} state=${state} />
            </div>

            <${HamburgerTwo.TAG} ref=${hamburgerRef} />
        </header>

        <div class="mobile-nav-menu${
            menuOpen ? ' open' : ''
        }">
            <nav>
                <a
                    href="/about"
                    class="header-link${
                        route.value === '/about' ?
                            ' active' :
                            ''
                    }"
                >
                    About
                </a>
            </nav>

            <div class="mobile-user">
                <${UserIcon} state=${state} />
                ${user.value && html`
                    <button
                        class="btn btn-small"
                        onClick=${handleLogout}
                    >
                        Logout
                    </button>
                `}
            </div>
        </div>
    `
}
