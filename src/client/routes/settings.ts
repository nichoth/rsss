import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useEffect } from 'preact/hooks'
import { type AppState, State } from '../state.js'
import {
    syncSubscriptions,
    storeContent,
    setSyncSubscriptions,
    saveLocalFirstSettings,
    loadLocalFirstSettings
} from '../local-first-settings.js'
import { isLocalFirstSupported } from '../db/index.js'
import '@substrate-system/check-box'
import './settings.css'

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { feeds } = state

    useEffect(() => {
        loadLocalFirstSettings()
    }, [])

    const supported = isLocalFirstSupported()

    function handleSyncChange (ev:Event) {
        const checked = (ev.target as HTMLInputElement).checked
        setSyncSubscriptions(checked)
        saveLocalFirstSettings()
    }

    function handleContentChange (ev:Event) {
        const checked = (ev.target as HTMLInputElement).checked
        storeContent.value = checked
        saveLocalFirstSettings()
    }

    return html`<div class="route settings">
        <header class="settings-header">
            <a href="/" class="back-link">${'<'} Back to Feeds</a>
            <h1>Settings</h1>
        </header>

        <section class="settings-section local-first-section">
            <h2>Local Storage</h2>
            ${!supported && html`
                <p class="unsupported-note">
                    Local storage is not supported in this browser.
                </p>
            `}
            <div class="local-first-toggle">
                <check-box
                    name="sync-subscriptions"
                    checked=${syncSubscriptions.value || undefined}
                    disabled=${!supported || undefined}
                    onChange=${handleSyncChange}
                >
                    Sync subscriptions and read state to this device
                </check-box>
            </div>
            <div class="local-first-toggle">
                <check-box
                    name="store-content"
                    checked=${storeContent.value || undefined}
                    disabled=${(!supported || !syncSubscriptions.value) ||
                        undefined}
                    onChange=${handleContentChange}
                >
                    Store article content locally for offline reading
                </check-box>
            </div>
        </section>

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
