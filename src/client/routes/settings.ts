import { html } from 'htm/preact'
import { useCallback } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { useComputed, useSignal } from '@preact/signals'
import { CheckBox } from '@substrate-system/check-box'
import { match } from '../util.js'
import { type AppState, State } from '../state.js'
import '@substrate-system/check-box/css'
import './settings.css'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:view')

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { feeds, isOnline } = state
    const checkResolving = useSignal<string | null>(null)

    const handleToggleCaching = useCallback(async (ev: InputEvent) => {
        const box = ev.target as HTMLInputElement
        const isCached = !!box.checked
        const el = match(box, CheckBox.TAG)  // the custom element
        checkResolving.value = el!.id
        const feedId = parseInt(el!.id)
        await State.toggleFeedCached(state, feedId, isCached)
        checkResolving.value = null
    }, [])

    return html`<div class="route settings">
        <header class="settings-header">
            <a href="/" class="back-link">${'<'} Back to Feeds</a>
            <h1>Settings</h1>
        </header>

        <section class="settings-section">
            <h2>This Device</h2>
            <p class="section-desc">
                Settings local to this device
            </p>
            
            <ul class="settings-feeds-list">
                ${feeds.value.length === 0 ?
                    html`<p class="empty-state">No feeds followed yet.</p>` :
                    feeds.value.map(feed => {
                        const isResolving = useComputed(() => {
                            return checkResolving.value === ('' + feed.id)
                        })

                const className = ('settings-feed-item' + (isResolving.value ?
                    ' resolving' :
                    ''))

                return html`
                        <li class="${className}" key=${feed.url}>
                            <div class="feed-info">
                                <span class="feed-title">
                                    ${feed.title || feed.url}
                                </span>
                            </div>
                            <div class="feed-controls">
                                <${CheckBox.TAG}
                                    checked=${feed.is_locally_cached === 1}
                                    id=${feed.id}
                                    onChange=${handleToggleCaching}
                                    disabled=${false}
                                >
                                    Cache Locally
                                <//>
                            </div>
                        </li>
                        `
            })
        }
            </ul>
        </section>

        <section class="settings-section">
            <h2>Global Settings</h2>
            <p class="section-desc">
                Settings that sync across all your devices.
            </p>

            <h3>Subscribed Feeds</h3>
            <ul class="settings-feeds-list">
                ${feeds.value.length === 0 ?
            html`
                        <p class="empty-state">No feeds followed yet.</p>
                    ` : feeds.value.map(feed => {
                return html`
                        <li class="settings-feed-item" key=${feed.url + '-global'}>
                            <div class="feed-info">
                                <span class="feed-title">
                                    ${feed.title || feed.url}
                                </span>
                                <a href="${feed.url}" class="feed-url">
                                    ${feed.url}
                                </a>
                            </div>
                            <button 
                                class="btn-delete"
                                onClick=${(e: Event) => {
                                    e.preventDefault()
                                    if (confirm('Are you sure you want to unfollow this feed?')) {
                                        State.deleteFeed(state, feed.id)
                                    }
                                }}
                                disabled=${!isOnline.value}
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
