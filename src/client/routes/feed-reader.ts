import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useCallback, useEffect, useMemo } from 'preact/hooks'
import '@substrate-system/check-box'
import '@substrate-system/tool-tip'
import {
    State,
    type AppState,
    stripProtocol,
} from '../state.js'
import { ItemRow } from '../components/item-row.js'
import { Sidebar } from '../components/sidebar.js'
import { CacheSettings } from '../components/cache-settings.js'
import {
    PendingUpdateEmptyState
} from '../components/pending-update-empty-state.js'
import Debug from '@substrate-system/debug'
const debug = Debug('rsss:view:feed-reader')

/**
 * This is the home route.
 */
export const FeedReader:FunctionComponent<{
    state:AppState;
    splats:string[];
}> = function FeedReader ({ state, splats }) {
    const {
        feeds,
        items,
        counts,
        itemsLoading,
        itemsTotal,
        itemsOffset,
        showUnreadOnly,
        pageSize,
    } = state

    debug('rendering feed reader...', feeds)

    // Extract feed URL from splats (everything after /feed/)
    const feedUrl = useMemo(() => splats.join('/'), [splats.join('/')])

    // Find the feed by URL
    const selectedFeed = useMemo(() => {
        if (!feedUrl) return null
        return feeds.value.find(f => stripProtocol(f.url) === feedUrl) || null
    }, [feedUrl, feeds.value])

    const pendingCount = (() => {
        const updateCounts = state.feedUpdateCounts.value
        if (state.selectedFeedId.value !== null) {
            return updateCounts[String(state.selectedFeedId.value)] ?? 0
        }
        return Object.values(updateCounts).reduce((a, b) => a + b, 0)
    })()

    const handleRefreshPending = useCallback(
        async ():Promise<void> => {
            const feedId = state.selectedFeedId.value
            if (feedId !== null) {
                await State.refreshFeed(state, String(feedId))
            } else {
                await State.refreshFeeds(state)
            }
        },
        []
    )

    // Sync selected feed into state so loadItems
    // filters at the query level
    useEffect(() => {
        const newId = selectedFeed?.id ?? null
        if (state.selectedFeedId.value !== newId) {
            state.selectedFeedId.value = newId
            state.itemsOffset.value = 0
            State.loadItems(state)
        }

        return () => {
            // Clear feed filter when leaving this view
            if (state.selectedFeedId.value !== null) {
                state.selectedFeedId.value = null
                state.itemsOffset.value = 0
                State.loadItems(state)
            }
        }
    }, [selectedFeed?.id])

    const handleToggleUnread = useCallback(() => {
        state.showUnreadOnly.value = !state.showUnreadOnly.value
        state.itemsOffset.value = 0
        State.loadItems(state)
    }, [])

    const handleMarkAllRead = useCallback(async () => {
        await State.markAllRead(state, selectedFeed?.id)
    }, [])

    const handlePrevPage = useCallback(() => {
        state.itemsOffset.value = Math.max(
            0,
            state.itemsOffset.value - pageSize.value
        )
        State.loadItems(state)
    }, [])

    const handleNextPage = useCallback(() => {
        state.itemsOffset.value =
            state.itemsOffset.value + pageSize.value
        State.loadItems(state)
    }, [])

    const handlePageSizeChange = useCallback((ev:Event) => {
        const target = ev.target as HTMLSelectElement
        state.pageSize.value = parseInt(target.value, 10)
        state.itemsOffset.value = 0
        State.loadItems(state)
    }, [])

    const renderEmptyState = ():unknown => {
        if (feeds.value.length === 0) {
            return html`<div class="empty-state">
                Maybe add some feeds to start reading.
            </div>`
        }
        if (pendingCount > 0) {
            return html`<${PendingUpdateEmptyState}
                count=${pendingCount}
                onRefresh=${handleRefreshPending}
            />`
        }
        if (selectedFeed) {
            return html`<div class="empty-state">
                No items in ${selectedFeed.title || selectedFeed.url}
            </div>`
        }
        return html`<div class="empty-state">
            No items to show.
        </div>`
    }

    const hasPrev = itemsOffset.value > 0
    const hasNext = itemsOffset.value + pageSize.value < itemsTotal.value
    const pageStart = itemsTotal.value === 0 ? 0 : itemsOffset.value + 1
    const pageEnd = Math.min(
        itemsOffset.value + pageSize.value,
        itemsTotal.value
    )

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
                            <${CacheSettings}
                                state=${state}
                                selectedFeed=${selectedFeed}
                            />
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
                            disabled=${counts.value.unread === 0}
                        >
                            Mark all read
                        </button>
                    </div>

                    <ul class="items-list">
                        ${itemsLoading.value && items.value.length === 0 && html`
                            <div class="loading-text">Loading items...</div>
                        `}

                        ${items.value.map(item => html`
                            <li key=${item.id}>
                                <${ItemRow}
                                    item=${item}
                                    state=${state}
                                />
                            </li>
                        `)}

                        ${!itemsLoading.value && items.value.length === 0 &&
                            renderEmptyState()}
                    </ul>

                    ${itemsTotal.value > 0 && html`
                        <div class="pagination">
                            <button
                                class="btn btn-small"
                                onClick=${handlePrevPage}
                                disabled=${!hasPrev}
                            >
                                Previous
                            </button>
                            <span class="pagination-info">
                                ${pageStart}--${pageEnd}
                                ${' of '}${itemsTotal.value}
                            </span>
                            <button
                                class="btn btn-small"
                                onClick=${handleNextPage}
                                disabled=${!hasNext}
                            >
                                Next
                            </button>

                            <select
                                class="page-size-select"
                                value=${pageSize.value}
                                onChange=${handlePageSizeChange}
                            >
                                <option value="20">20</option>
                                <option value="40">40</option>
                                <option value="60">60</option>
                                <option value="100">100</option>
                            </select>
                        </div>
                    `}
                </main>
            </div>
        </div>
    `
}
