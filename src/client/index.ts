import { html } from 'htm/preact'
import { type FunctionComponent, render } from 'preact'
import { useComputed } from '@preact/signals'
import * as Sentry from '@sentry/browser'
import { State, type AppState } from './state.js'
import { isItemRoute } from './routing.js'
import Router from './routes/index.js'
import { NotFound } from './not-found.js'
import { Header } from './components/header.js'
import { PageSkeleton } from './components/page-skeleton.js'
import { ItemSkeleton } from './components/item-skeleton.js'
import { OAuthCallbackLoader } from './components/oauth-loader.js'
import '@substrate-system/details-summary'
import './style.css'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:view:index')

Sentry.onLoad(() => {
    Sentry.init({
        dsn: 'https://82d618eec50410dfa68b790d8a9c2e96@o4511016664694784.ingest.us.sentry.io/4511392179355648',
        // Setting this option to true will send default PII data to Sentry.
        // For example, automatic IP address collection on events
        sendDefaultPii: false
    })
})

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
    const pageReady = useComputed(() => (
        !state.authLoading.value &&
        (state.user.value === null || state.initialLoadComplete.value)
    ))

    const route = useComputed(() => state.route.value)

    const match = useComputed(() => {
        return router.match(route.value)
    })

    if (!match.value || !match.value.action) {
        return html`<${NotFound} />`
    }

    if (state.oauthInFlight.value) {
        return html`<${OAuthCallbackLoader} />`
    }

    if (!pageReady.value) {
        if (isItemRoute(route.value)) {
            return html`<${ItemSkeleton} state=${state} />`
        }
        if (route.value === '/' || route.value.startsWith('/feed/')) {
            return html`<${PageSkeleton} state=${state} />`
        }
        // Other routes (login, about, settings, etc.) don't depend on
        // feeds/items; render them normally even before pageReady.
    }

    const ChildNode = match.value.action(match.value, route.value)
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
