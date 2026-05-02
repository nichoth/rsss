import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useEffect } from 'preact/hooks'
import { type AppState } from '../state.js'
import './updates.css'

export const UpdatesRoute:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    useEffect(() => {
        if (!state.authLoading.value && !state.isAuthenticated.value) {
            state._setRoute('/login')
        }
    }, [state.authLoading.value, state.isAuthenticated.value])

    if (!state.isAuthenticated.value) return null

    const pendingIds = state.feedsWithUpdates.value
    const feeds = state.feeds.value

    const pendingFeeds = pendingIds.map(id => {
        const feed = feeds.find(f => String(f.id) === id)
        return { id, title: feed?.title || feed?.url || id }
    })

    return html`
        <div class="route updates">
            <header class="updates-header">
                <a href="/" class="back-link">${'<'} Back to Feeds</a>
                <h1>Pending Updates</h1>
            </header>

            ${pendingFeeds.length === 0 ?
                html`<p class="empty-state">All feeds are up to date.</p>` :
                html`<ul class="updates-feed-list">
                    ${pendingFeeds.map(f => html`
                        <li key=${f.id} class="updates-feed-item">
                            <span class="feed-title">${f.title}</span>
                        </li>
                    `)}
                </ul>`
            }
        </div>
    `
}
