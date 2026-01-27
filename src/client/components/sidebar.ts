import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import { useState, useCallback } from 'preact/hooks'
import { SidebarItem } from './sidebar-item.js'
import { SidebarFooter } from '../components/sidebar-footer.js'
import { Button } from '../components/button.js'
import { CloseIcon } from '../components/close.js'
import { CacheIcon } from '../components/cache-icon.js'
import { ELLIPSIS } from '../constants.js'
import { ButtonIcon } from './button-icon.js'
import { type Feed, type AppState, State } from '../state.js'

export const Sidebar:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const {
        isOnline,
        selectedFeedId,
        feedsLoading,
        feeds,
    } = state
    const [showAddFeed, setShowAddFeed] = useState(false)
    const [addingFeed, setAddingFeed] = useState(false)
    const [addFeedError, setAddFeedError] = useState<string|null>(null)
    const [newFeedUrl, setNewFeedUrl] = useState('')

    async function handleDeleteFeed (feed:Feed) {
        if (confirm(`Delete "${feed.title || feed.url}"?`)) {
            await State.deleteFeed(state, feed.id)
        }
    }

    async function handleToggleCache (feed:Feed, e:Event) {
        e.stopPropagation()
        const newStatus = feed.is_locally_cached === 0
        await State.toggleFeedCached(state, feed.id, newStatus)
    }

    const handleAddFeed = useCallback(async (ev:MouseEvent) => {
        ev.preventDefault()
        if (!newFeedUrl.trim()) return

        setAddingFeed(true)
        setAddFeedError(null)

        const result = await State.addFeed(state, newFeedUrl.trim())

        if (result.success) {
            setNewFeedUrl('')
            setShowAddFeed(false)
        } else {
            setAddFeedError(result.error || 'Failed to add feed')
        }

        setAddingFeed(false)
    }, [])

    return html`
        <aside class="sidebar">
            <div class="sidebar-section">
                <${SidebarItem} state=${state} starred=${false}>
                    All Items
                <//>
                <${SidebarItem} state=${state} starred=${true}>
                    Starred
                <//>
            </div>

            <div class="sidebar-section">
                <div class="sidebar-header">
                    <h3>Feeds</h3>
                    <${ButtonIcon}
                        class="btn btn-icon"
                        onClick=${() => setShowAddFeed(!showAddFeed)}
                        title=${isOnline.value ?
                            'Add feed' :
                            'Cannot add feeds while offline'}
                        disabled=${!isOnline.value}
                    >
                        +
                    <//>
                </div>

                ${showAddFeed && html`
                    <form class="add-feed-form" onSubmit=${handleAddFeed}>
                        <input
                            type="url"
                            placeholder="https://example.com/feed.xml"
                            value=${newFeedUrl}
                            onInput=${(e:Event) => setNewFeedUrl((e.target as HTMLInputElement).value)}
                            disabled=${addingFeed || !isOnline.value}
                        />
                        <${Button}
                            type="submit"
                            disabled=${addingFeed || !newFeedUrl.trim() || !isOnline.value}
                        >
                            ${addingFeed ? '...' : 'Add'}
                        <//>
                        ${!isOnline.value && html`<div class="form-error">
                            Offline - cannot add feeds
                        </div>`}
                        ${addFeedError && html`<div
                            class="form-error"
                        >
                            ${addFeedError}
                        </div>`}
                    </form>
                `}

                <div class="feeds-list">
                    ${feedsLoading.value && feeds.value.length === 0 && html`
                        <div class="loading-text">Loading feeds...</div>
                    `}

                    ${feeds.value.map(feed => html`
                        <div
                            class="sidebar-item feed-item ${selectedFeedId.value === feed.id ? 'active' : ''}"
                            key=${feed.id}
                        >
                            <a
                                class="feed-select"
                                href="/${feed.url}"
                            >
                                ${feed.title || feed.url}
                            </a>

                            <tool-tip content=${feed.is_locally_cached === 1 ? 'Switch to on-demand fetching' : 'Switch to local caching'}>
                                <button
                                    class="btn-cache"
                                    onClick=${(e: Event) => handleToggleCache(feed, e)}
                                    aria-label=${feed.is_locally_cached === 1 ? 'Disable local cache' : 'Enable local cache'}
                                    disabled=${!isOnline.value}
                                >
                                    <${CacheIcon} cached=${feed.is_locally_cached === 1} />
                                </button>
                            </tool-tip>
                            <tool-tip content="Delete feed">
                                <button
                                    class="btn-delete"
                                    onClick=${() => handleDeleteFeed(feed)}
                                    aria-label="Delete feed"
                                    disabled=${!isOnline.value}
                                >
                                    <${CloseIcon} />
                                </button>
                            </tool-tip>
                        </div>
                    `)}

                    ${((!feedsLoading.value &&
                        feeds.value.length === 0) &&
                        html`
                            <div class="empty-state">
                                No feeds yet${ELLIPSIS}
                            </div>
                        `)
}
                </div>
            </div>

            <${SidebarFooter} state=${state} />
        </aside>
    `
}
