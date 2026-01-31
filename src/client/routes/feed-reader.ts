import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useMemo } from 'preact/hooks'
import '@substrate-system/check-box'
import '@substrate-system/tool-tip'
import { State, type AppState } from '../state.js'
import { ItemRow } from '../components/item-row.js'
import { Sidebar } from '../components/sidebar.js'
import Debug from '@substrate-system/debug'
const debug = Debug('rsss:view')

export const FeedReader:FunctionComponent<{
    state:AppState;
    splats:string[];
}> = function FeedReader ({ state, splats }) {
    const {
        feeds,
        items,
        counts,
        itemsLoading,
        showUnreadOnly,
        isOnline,
    } = state

    // Extract feed URL from splats (everything after /feed/)
    const feedUrl = useMemo(() => {
        return splats.join('/')
    }, [splats.join('/')])

    // Find the feed by URL
    const selectedFeed = useMemo(() => {
        if (!feedUrl) return null
        return feeds.value.find(f => f.url === feedUrl) || null
    }, [feedUrl, feeds.value])

    // Filter items based on the selected feed (client-side)
    const filteredItems = useMemo(() => {
        if (!selectedFeed) return items.value
        return items.value.filter(item => item.feed_id === selectedFeed.id)
    }, [items.value, selectedFeed?.id])

    debug('Feed URL:', feedUrl, 'Selected feed:', selectedFeed)

    function handleToggleUnread () {
        state.showUnreadOnly.value = !state.showUnreadOnly.value
        state.itemsOffset.value = 0
        State.loadItems(state)
    }

    async function handleMarkAllRead () {
        await State.markAllRead(state, selectedFeed?.id)
    }

    // Get the feed title for display
    const feedTitle = selectedFeed?.title || feedUrl || 'All Feeds'

    return html`
        <div class="route feed-reader">
            <div class="app-body">
                <${Sidebar} state=${state} />

                <main class="content">
                    <div class="items-header">
                        ${selectedFeed && html`
                            <h2 class="feed-title">${feedTitle}</h2>
                        `}
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

                    <ul class="items-list">
                        ${itemsLoading.value && filteredItems.length === 0 && html`
                            <div class="loading-text">Loading items...</div>
                        `}

                        ${filteredItems.map(item => html`
                            <li>
                            <${ItemRow}
                                key=${item.id}
                                item=${item}
                                state=${state}
                            />
                            </li>
                        `)}

                        ${!itemsLoading.value && filteredItems.length === 0 && html`
                            <div class="empty-state">
                                ${feeds.value.length === 0 ?
                                    'Maybe add some feeds to start reading.' :
                                    selectedFeed ?
                                        `No items in ${selectedFeed.title || selectedFeed.url}` :
                                        'No items to show.'}
                            </div>
                        `}
                    </ul>
                </main>
            </div>
        </div>
    `
}
