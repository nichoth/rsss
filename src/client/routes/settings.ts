import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { type AppState, State } from '../state.js'
import './settings.css'

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { feeds } = state

    return html`<div class="route settings">
        <header class="settings-header">
            <a href="/" class="back-link">${'<'} Back to Feeds</a>
            <h1>Settings</h1>
        </header>

        <section class="settings-section">
            <h2>Subscribed Feeds</h2>
            <ul class="settings-feeds-list">
                ${feeds.value.length === 0 ?
            html`
                        <p class="empty-state">
                            No feeds followed yet.
                        </p>
                    ` : feeds.value.map(feed => {
                return html`
                        <li
                            class="settings-feed-item"
                            key=${feed.url}
                        >
                            <div class="feed-info">
                                <span class="feed-title">
                                    ${feed.title || feed.url}
                                </span>
                                <a
                                    href="${feed.url}"
                                    class="feed-url"
                                >
                                    ${feed.url}
                                </a>
                            </div>
                            <button
                                class="btn-delete"
                                onClick=${(e:Event) => {
                                    e.preventDefault()
                                    if (confirm(
                                        'Are you sure you want' +
                                        ' to unfollow this feed?'
                                    )) {
                                        State.deleteFeed(
                                            state,
                                            feed.id
                                        )
                                    }
                                }}
                            >
                                Unfollow
                            </button>
                        </li>
                        `
            })
        }
            </ul>
        </section>
    </div>`
}
