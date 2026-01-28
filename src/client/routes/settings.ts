import { html } from 'htm/preact'
import { useCallback } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { CheckBox } from '@substrate-system/check-box'
import { type AppState, State } from '../state.js'
import '@substrate-system/check-box/css'
import './settings.css'

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { feeds, isOnline } = state

    const handleToggleCaching = useCallback(async (ev:InputEvent) => {
        const box = ev.target as HTMLInputElement
        const feedId = parseInt(box.id!)
        const isCached = !!box.checked
        await State.toggleFeedCached(state, feedId, isCached)
    }, [])

    return html`<div class="route settings">
        <header class="settings-header">
            <a href="/" class="back-link">← Back to Feeds</a>
            <h1>Settings</h1>
        </header>

        <section class="settings-section">
            <h2>Feeds</h2>
            <div class="settings-feeds-list">
                ${feeds.value.length === 0 ? html`
                    <p class="empty-state">No feeds followed yet.</p>
                ` : feeds.value.map(feed => html`
                    <div class="settings-feed-item" key=${feed.id}>
                        <div class="feed-info">
                            <span class="feed-title">${feed.title || feed.url}</span>
                            <span class="feed-url">${feed.url}</span>
                        </div>
                        <div class="feed-controls">
                            <${CheckBox.TAG}
                                checked=${feed.is_locally_cached === 1}
                                id=${feed.id}
                                onChange=${handleToggleCaching}
                                disabled=${!isOnline.value}
                            >
                                Cached Locally
                            <//>
                        </div>
                    </div>
                `)}
            </div>
        </section>
    </div>`
}
