import { html } from 'htm/preact'
import { type FunctionComponent, render } from 'preact'
import { useComputed } from '@preact/signals'
import { State, type AppState } from './state.js'
import Router from './routes/index.js'
import { NotFound } from './not-found.js'
import { Header } from './components/header.js'
import '@substrate-system/details-summary'
import './style.css'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:view:index')

const state = State()
const router = Router(state)

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        state.cleanup()
    })
}

export const DEFAULT_DEBUG = 'rsss,rsss:*'

/**
 * Debug logging
 */
if (import.meta.env.DEV || import.meta.env.MODE === 'staging') {
    // @ts-expect-error DEV env
    window.state = state
    localStorage.setItem('DEBUG', DEFAULT_DEBUG)
} else {
    localStorage.removeItem('DEBUG')
}

/**
 * Main app
 */
export const App:FunctionComponent<{
    state:AppState
}> = function App ({ state }) {
    const authLoading = useComputed(() => state.authLoading.value)

    const match = useComputed(() => {
        return router.match(state.route.value)
    })

    if (!match.value || !match.value.action) {
        return html`<${NotFound} />`
    }

    // Loading state
    if (authLoading.value) {
        return html`
            <div class="loading-screen">
                <div class="loading-spinner"></div>
                <p>Loading...</p>
            </div>
        `
    }

    const ChildNode = match.value.action(match.value, state.route.value)
    const { params, splats } = match.value
    if (!ChildNode) return html`<${NotFound} />`

    return html`
        <${Header} state=${state} />
        <${ChildNode} state=${state} params=${params} splats=${splats} />
        <footer>
            <nav class="footer-links" aria-label="Footer">
                <a href="/terms">Terms</a>
                <a href="/privacy">Privacy</a>
            </nav>
        </footer>
    `
}

render(html`<${App} state=${state} />`, document.getElementById('root')!)
