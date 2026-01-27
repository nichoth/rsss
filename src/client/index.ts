import { html } from 'htm/preact'
import { type FunctionComponent, render } from 'preact'
import { useComputed } from '@preact/signals'
import { State, type AppState } from './state.js'
import Router from './routes/index.js'
import { FeedReader } from './routes/feed-reader.js'
import './style.css'

const state = State()
const router = Router(state)

if (import.meta.env.DEV || import.meta.env.MODE === 'staging') {
    // @ts-expect-error DEV env
    window.state = state
    localStorage.setItem('DEBUG', 'rsss,rsss:*')
} else {
    localStorage.removeItem('DEBUG')
}

export const App: FunctionComponent<{
    state: AppState
}> = function App ({ state }) {
    const authLoading = useComputed(() => state.authLoading.value)

    const match = useComputed(() => {
        return router.match(state.route.value)
    })

    if (!match.value || !match.value.action) {
        if (State.isItemRoute(state.route.value)) {
            return html`<${FeedReader} state=${state} />`
        }

        return html`<div class="not-found">
            <h1>404</h1>
            <p>Page not found</p>
            <a href="/">Go home</a>
        </div>`
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

    return html`
        <${ChildNode} state=${state} />
        <footer>
            <iframe
                src="https://github.com/sponsors/nichoth/card"
                title="Sponsor nichoth"
            ></iframe>
        </footer>
    `
}

render(html`<${App} state=${state} />`, document.getElementById('root')!)
