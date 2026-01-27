import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useState } from 'preact/hooks'
import '@substrate-system/check-box'
import '@substrate-system/tool-tip'
import { State, type AppState, type Feed } from '../state.js'
import { ItemReader } from '../components/item-reader.js'
import { SidebarItem } from '../components/sidebar-item.js'
import { ItemRow } from '../components/item-row.js'
import { SidebarFooter } from '../components/sidebar-footer.js'
import { Button } from '../components/button.js'
import { ButtonIcon } from '../components/button-icon.js'
import { CloseIcon } from '../components/close.js'
import { CacheIcon } from '../components/cache-icon.js'
import { StatusIndicator } from '../components/status-indicator.js'
import { ELLIPSIS } from '../constants.js'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:view')

export const FeedReader: FunctionComponent<{
    state: AppState
}> = function FeedReader ({ state }) {
    const {
        user,
        feeds,
        items,
        counts,
        selectedItem,
        selectedFeedId,
        feedsLoading,
        itemsLoading,
        showUnreadOnly,
        isOnline,
    } = state

    const [newFeedUrl, setNewFeedUrl] = useState('')
    const [addingFeed, setAddingFeed] = useState(false)
    const [addFeedError, setAddFeedError] = useState<string | null>(null)
    const [showAddFeed, setShowAddFeed] = useState(false)

    async function handleAddFeed (e: Event) {
        e.preventDefault()
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
    }

    async function handleDeleteFeed (feed: Feed) {
        if (confirm(`Delete "${feed.title || feed.url}"?`)) {
            await State.deleteFeed(state, feed.id)
        }
    }

    function handleSelectFeed (feedId: number | null) {
        state.selectedFeedId.value = feedId
        state.showStarredOnly.value = false
        state.itemsOffset.value = 0
        State.loadItems(state)
    }

    function handleToggleUnread () {
        state.showUnreadOnly.value = !state.showUnreadOnly.value
        state.itemsOffset.value = 0
        State.loadItems(state)
    }

    async function handleMarkAllRead () {
        await State.markAllRead(state, state.selectedFeedId.value || undefined)
    }

    async function handleLogout () {
        await State.logout(state)
    }

    async function handleToggleCache (feed: Feed, e: Event) {
        e.stopPropagation()
        const newStatus = feed.is_locally_cached === 0
        await State.toggleFeedCached(state, feed.id, newStatus)
    }

    // If an item is selected, show the reader view
    if (selectedItem.value) {
        return html`<${ItemReader}
            item=${selectedItem.value}
            state=${state}
            onClose=${() => State.clearSelectedItem(state)}
        />`
    }

    return html`
        <div class="route feed-reader">
            <header class="app-header">
                <div class="header header-left">
                    <h1>RSSS</h1>
                    <div>Really Simple Syndication Service</div>
                </div>
                <div class="header header-right">
                    <${StatusIndicator}
                        type=${isOnline.value ? 'online' : 'offline'}
                        title=${isOnline.value ? 'Online' : 'Offline'}
                    />
                    <a href="/about" class="header-link">About</a>
                    <span class="user-handle">@${user.value?.handle}</span>
                    <button class="btn btn-small" onClick=${handleLogout}>Logout</button>
                </div>
            </header>

            <div class="app-body">
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
                                title=${isOnline.value ? 'Add feed' : 'Cannot add feeds while offline'}
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
                                    onInput=${(e: Event) => setNewFeedUrl((e.target as HTMLInputElement).value)}
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
                                    <${StatusIndicator}
                                        type=${feed.is_locally_cached === 1 ? 'cached' : 'remote'}
                                        title=${feed.is_locally_cached === 1 ? 'Locally cached' : 'Cloud only'}
                                    />
                                    <button
                                        class="feed-select"
                                        onClick=${() => handleSelectFeed(feed.id)}
                                    >
                                        ${feed.title || feed.url}
                                    </button>
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

                            ${(
            !feedsLoading.value &&
            feeds.value.length === 0 &&
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

                <main class="content">
                    <div class="items-header">
                        <div class="items-filters">
                            <check-box
                                name="unread"
                                class="filter-checkbox"
                                checked=${showUnreadOnly.value}
                                onChange=${handleToggleUnread}
                            >
                                Unread only
                            </check-box>
                        </div>
                        <button
                            class="btn btn-small"
                            onClick=${handleMarkAllRead}
                            disabled=${counts.value.unread === 0 || !isOnline.value}
                            title=${isOnline.value ? '' : 'Cannot mark read while offline'}
                        >
                            Mark all read
                        </button>
                    </div>

                    <div class="items-list">
                        ${itemsLoading.value && items.value.length === 0 && html`
                            <div class="loading-text">Loading items...</div>
                        `}

                        ${items.value.map(item => html`
                            <${ItemRow}
                                key=${item.id}
                                item=${item}
                                state=${state}
                            />
                        `)}

                        ${!itemsLoading.value && items.value.length === 0 && html`
                            <div class="empty-state">
                                ${feeds.value.length === 0 ?
                'Maybe add some feeds to start reading.' :
                'No items to show.'}
                            </div>
                        `}
                    </div>
                </main>
            </div>
        </div>
    `
}
