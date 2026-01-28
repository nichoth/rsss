import { html } from 'htm/preact'
import { useCallback } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { useComputed, useSignal } from '@preact/signals'
import { CheckBox } from '@substrate-system/check-box'
import { type AppState, State } from '../state.js'
import Debug from '@substrate-system/debug'
import '@substrate-system/check-box/css'
import './settings.css'
const debug = Debug('rsss:view')

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { feeds, isOnline } = state
    const checkResolving = useSignal<string|null>(null)

    const handleToggleCaching = useCallback(async (ev:InputEvent) => {
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
            <h2>Feeds</h2>
            <ul class="settings-feeds-list">
                ${feeds.value.length === 0 ?
                    html`
                        <p class="empty-state">No feeds followed yet.</p>
                    ` : feeds.value.map(feed => {
                        const isResolving = useComputed(() => {
                            return checkResolving.value === ('' + feed.id)
                        })

                    debug('is resolving...?', isResolving.value, feed.id)

                    const className = ('settings-feed-item' + (isResolving.value ?
                        'resolving' :
                        ''))

                    return html`
                        <li class="${className}" key=${feed.url}>
                            <div>
                                <div class="feed-info">
                                    <span class="feed-title">
                                        ${feed.title || feed.url}
                                    </span>
                                    <a href="${feed.url}" class="feed-url">
                                        ${feed.url}
                                    </a>
                                </div>
                                <div class="feed-controls">
                                    <${CheckBox.TAG}
                                        checked=${feed.is_locally_cached === 1}
                                        id=${feed.id}
                                        onChange=${handleToggleCaching}
                                        disabled=${!isOnline.value}
                                    >
                                        Cache Locally
                                    <//>
                                </div>
                            </div>
                            <div>More controls</div>
                        </li>
                        `
                    })
                }
            </ul>
        </section>
    </div>`
}

/**
 * Get the closes parent element matching the given selector.
 * @param el Element to start from
 * @param s Selector for an element
 * @returns {HTMLElement|null} The closes parent element that matches.
 */
function match (el:HTMLElement, s:string):HTMLElement|null {
    if (!el.matches) el = el.parentElement!
    return el.matches(s) ? el : el.closest(s)
}
