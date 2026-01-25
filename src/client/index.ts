import { html } from 'htm/preact'
import { type FunctionComponent, render } from 'preact'
import { useEffect } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import {
    State,
    type AppState
} from './state.js'
import { LoginPage } from './routes/login.js'
import { FeedReader } from './routes/feed-reader.js'
import './style.css'

const state = State()

if (import.meta.env.DEV || import.meta.env.MODE === 'staging') {
    // @ts-expect-error DEV env
    window.state = state
    localStorage.setItem('DEBUG', 'rsss,rsss:*')
} else {
    localStorage.removeItem('DEBUG')
}

export const App: FunctionComponent<{
    state:AppState
}> = function App ({ state }) {
    const route = useComputed(() => state.route.value)
    const isAuthenticated = useComputed(() => state.isAuthenticated.value)
    const authLoading = useComputed(() => state.authLoading.value)

    // Load data when authenticated
    useEffect(() => {
        if (isAuthenticated.value) {
            State.loadFeeds(state)
            State.loadItems(state).then(() => {
                // After items load, check if we need to select one based on URL
                State.handleRouteChange(state)
            })
            State.loadCounts(state)
        }
    }, [isAuthenticated.value])

    // Handle route changes (including back/forward navigation)
    useEffect(() => {
        if (isAuthenticated.value && state.items.value.length > 0) {
            State.handleRouteChange(state)
        }
    }, [route.value, isAuthenticated.value])

    // Redirect to login if not authenticated
    useEffect(() => {
        if (!authLoading.value && !isAuthenticated.value) {
            if (!route.value.startsWith('/login')) {
                state._setRoute('/login')
            }
        }
    }, [authLoading.value, isAuthenticated.value, route.value])

    // Loading state
    if (authLoading.value) {
        return html`
            <div class="loading-screen">
                <div class="loading-spinner"></div>
                <p>Loading...</p>
            </div>
        `
    }

    // Login page
    if (route.value.startsWith('/login') || !isAuthenticated.value) {
        return html`<${LoginPage} state=${state} />`
    }

    // Main app
    return html`<${FeedReader} state=${state} />`
}

render(html`<${App} state=${state} />`, document.getElementById('root')!)
