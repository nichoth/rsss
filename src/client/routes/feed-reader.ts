import { html } from 'htm/preact'
import { FunctionComponent } from 'preact'
import { useState } from 'preact/hooks'
import {
    logout,
    loadItems,
    addFeed,
    deleteFeed,
    refreshFeeds,
    selectItem,
    clearSelectedItem,
    toggleItemRead,
    toggleItemStarred,
    markAllRead,
    type AppState,
    type Item,
    type Feed
} from '../state.js'
import { Button } from '../components/button.js'
import { ButtonIcon } from '../components/button-icon.js'
import { ELLIPSIS } from '../constants.js'

export const FeedReader: FunctionComponent<{ state: AppState }> = function FeedReader ({ state }) {
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
        showStarredOnly
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

        const result = await addFeed(state, newFeedUrl.trim())

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
            await deleteFeed(state, feed.id)
        }
    }

    async function handleRefresh () {
        await refreshFeeds(state)
    }

    function handleSelectFeed (feedId: number | null) {
        state.selectedFeedId.value = feedId
        state.showStarredOnly.value = false
        state.itemsOffset.value = 0
        loadItems(state)
    }

    function handleToggleUnread () {
        state.showUnreadOnly.value = !state.showUnreadOnly.value
        state.itemsOffset.value = 0
        loadItems(state)
    }

    function handleShowStarred () {
        state.showStarredOnly.value = true
        state.selectedFeedId.value = null
        state.itemsOffset.value = 0
        loadItems(state)
    }

    function handleShowAll () {
        state.showStarredOnly.value = false
        state.selectedFeedId.value = null
        state.itemsOffset.value = 0
        loadItems(state)
    }

    async function handleMarkAllRead () {
        await markAllRead(state, state.selectedFeedId.value || undefined)
    }

    async function handleLogout () {
        await logout(state)
    }

    // If an item is selected, show the reader view
    if (selectedItem.value) {
        return html`<${ItemReader}
            item=${selectedItem.value}
            state=${state}
            onClose=${() => clearSelectedItem(state)}
        />`
    }

    return html`
        <div class="feed-reader">
            <header class="app-header">
                <div class="header header-left">
                    <h1>RSSS</h1>
                    <div>Really Simple Syndication Service</div>
                </div>
                <div class="header header-right">
                    <span class="user-handle">@${user.value?.handle}</span>
                    <button class="btn btn-small" onClick=${handleLogout}>Logout</button>
                </div>
            </header>

            <div class="app-body">
                <aside class="sidebar">
                    <div class="sidebar-section">
                        <button
                            class="sidebar-item ${!selectedFeedId.value && !showStarredOnly.value ? 'active' : ''}"
                            onClick=${() => handleShowAll()}
                        >
                            <span>All Items</span>
                            <span class="badge">${counts.value.unread}</span>
                        </button>
                        <button
                            class="sidebar-item ${showStarredOnly.value ? 'active' : ''}"
                            onClick=${handleShowStarred}
                        >
                            <span>Starred</span>
                            <span class="badge">${counts.value.starred}</span>
                        </button>
                    </div>

                    <div class="sidebar-section">
                        <div class="sidebar-header">
                            <h3>Feeds</h3>
                            <${ButtonIcon}
                                class="btn btn-icon"
                                onClick=${() => setShowAddFeed(!showAddFeed)}
                                title="Add feed"
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
                                    disabled=${addingFeed}
                                />
                                <${Button}
                                    type="submit"
                                    disabled=${addingFeed || !newFeedUrl.trim()}
                                >
                                    ${addingFeed ? '...' : 'Add'}
                                <//>
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
                                    <button
                                        class="feed-select"
                                        onClick=${() => handleSelectFeed(feed.id)}
                                    >
                                        ${feed.title || feed.url}
                                    </button>
                                    <button
                                        class="btn-delete"
                                        onClick=${() => handleDeleteFeed(feed)}
                                        title="Delete feed"
                                    >
                                        x
                                    </button>
                                </div>
                            `)}

                            ${!feedsLoading.value && feeds.value.length === 0 && html`
                                <div class="empty-state">
                                    No feeds yet${ELLIPSIS}
                                </div>
                            `}
                        </div>
                    </div>

                    <div class="sidebar-footer">
                        <button
                            class="btn btn-small"
                            onClick=${handleRefresh}
                            disabled=${feedsLoading.value}
                        >
                            ${feedsLoading.value ? 'Refreshing...' : 'Refresh Feeds'}
                        </button>
                    </div>
                </aside>

                <main class="content">
                    <div class="items-header">
                        <div class="items-filters">
                            <label class="filter-checkbox">
                                <input
                                    type="checkbox"
                                    checked=${showUnreadOnly.value}
                                    onChange=${handleToggleUnread}
                                />
                                Unread only
                            </label>
                        </div>
                        <button
                            class="btn btn-small"
                            onClick=${handleMarkAllRead}
                            disabled=${counts.value.unread === 0}
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
                                onClick=${() => selectItem(state, item)}
                            />
                        `)}

                        ${!itemsLoading.value && items.value.length === 0 && html`
                            <div class="empty-state">
                                ${feeds.value.length === 0
                                    ? 'Maybe add some feeds to start reading.'
                                    : 'No items to show.'}
                            </div>
                        `}
                    </div>
                </main>
            </div>
        </div>
    `
}

const ItemRow: FunctionComponent<{
    item: Item
    state: AppState
    onClick: () => void
}> = function ItemRow ({ item, state, onClick }) {
    const isUnread = !item.is_read
    const isStarred = !!item.is_starred

    async function handleStar (e: Event) {
        e.stopPropagation()
        await toggleItemStarred(state, item.id, !isStarred)
    }

    function formatDate (dateStr: string | null): string {
        if (!dateStr) return ''
        const date = new Date(dateStr)
        const now = new Date()
        const diff = now.getTime() - date.getTime()

        if (diff < 60000) return 'just now'
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`

        return date.toLocaleDateString()
    }

    return html`
        <article
            class="item-row ${isUnread ? 'unread' : ''}"
            onClick=${onClick}
        >
            <div class="item-main">
                <h3 class="item-title">${item.title || '(No title)'}</h3>
                <div class="item-meta">
                    <span class="item-feed">${item.feed_title}</span>
                    ${item.pub_date && html`
                        <span class="item-date">${formatDate(item.pub_date)}</span>
                    `}
                </div>
                ${item.description && html`
                    <p class="item-excerpt">${stripHtml(item.description).slice(0, 200)}</p>
                `}
            </div>
            <div class="item-actions">
                <button
                    class="btn-star ${isStarred ? 'starred' : ''}"
                    onClick=${handleStar}
                    title=${isStarred ? 'Unstar' : 'Star'}
                >
                    ${isStarred ? '★' : '☆'}
                </button>
            </div>
        </article>
    `
}

const ItemReader: FunctionComponent<{
    item: Item
    state: AppState
    onClose: () => void
}> = function ItemReader ({ item, state, onClose }) {
    const isStarred = !!item.is_starred
    const isRead = !!item.is_read

    async function handleStar () {
        await toggleItemStarred(state, item.id, !isStarred)
    }

    async function handleToggleRead () {
        await toggleItemRead(state, item.id, !isRead)
    }

    function formatDate (dateStr: string | null): string {
        if (!dateStr) return ''
        return new Date(dateStr).toLocaleString()
    }

    return html`
        <div class="item-reader">
            <header class="reader-header">
                <button class="btn btn-back" onClick=${onClose}>
                    ← Back
                </button>
                <div class="reader-actions">
                    <button
                        class="btn btn-icon ${isStarred ? 'starred' : ''}"
                        onClick=${handleStar}
                        title=${isStarred ? 'Unstar' : 'Star'}
                    >
                        ${isStarred ? '★' : '☆'}
                    </button>
                    <button
                        class="btn btn-small"
                        onClick=${handleToggleRead}
                    >
                        ${isRead ? 'Mark unread' : 'Mark read'}
                    </button>
                    ${item.link && html`
                        <a
                            class="btn btn-small"
                            href=${item.link}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Open original
                        </a>
                    `}
                </div>
            </header>

            <article class="reader-content">
                <header class="article-header">
                    <h1>${item.title || '(No title)'}</h1>
                    <div class="article-meta">
                        <span class="article-feed">${item.feed_title}</span>
                        ${item.author && html`<span class="article-author">by ${item.author}</span>`}
                        ${item.pub_date && html`<span class="article-date">${formatDate(item.pub_date)}</span>`}
                    </div>
                </header>

                <div
                    class="article-body"
                    dangerouslySetInnerHTML=${{ __html: sanitizeHtml(item.content || item.description || '') }}
                />
            </article>
        </div>
    `
}

function stripHtml (html: string): string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function sanitizeHtml (html: string): string {
    // Basic sanitization - remove script tags and event handlers
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/\s*on\w+="[^"]*"/gi, '')
        .replace(/\s*on\w+='[^']*'/gi, '')
        .replace(/javascript:/gi, '')
}
