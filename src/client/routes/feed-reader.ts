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
import { type CacheMode } from '../local-first-settings.js'
import {
    feedPolicies,
    loadFeedPolicies,
    upsertFeedCachePolicy,
    resolveEffectivePolicy,
    type FeedCachePolicyRow
} from '../db/feed-cache-policy.js'
import {
    getBootstrappedDb,
    getLocalDb,
    clearFeedCache
} from '../db/index.js'
import { loadStorageUsage } from '../db/storage-usage.js'
import { ItemRow } from '../components/item-row.js'
import { Sidebar } from '../components/sidebar.js'
import Debug from '@substrate-system/debug'
import { NBSP } from '../constants.js'
const debug = Debug('rsss:view')

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

    debug('state.feeds', state.feeds.value)

    // Extract feed URL from splats (everything after /feed/)
    const feedUrl = useMemo(() => splats.join('/'), [splats.join('/')])

    // Find the feed by URL
    const selectedFeed = useMemo(() => {
        if (!feedUrl) return null
        return feeds.value.find(f => stripProtocol(f.url) === feedUrl) || null
    }, [feedUrl, feeds.value])

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

    useEffect(() => {
        if (!selectedFeed) return
        const did = state.user.value?.did
        const db = did ?
            (getBootstrappedDb() ?? getLocalDb(did)) :
            null
        if (!db) return
        loadFeedPolicies(db, [selectedFeed.id]).catch(() => {})
    }, [selectedFeed?.id])

    function getDb () {
        const did = state.user.value?.did
        return did ?
            (getBootstrappedDb() ?? getLocalDb(did)) :
            null
    }

    async function saveFeedPolicy (
        feedId:number,
        patch:Partial<FeedCachePolicyRow>
    ):Promise<void> {
        const current = feedPolicies.value[feedId] ?? null
        const updated:FeedCachePolicyRow = {
            feed_id: feedId,
            cache_mode: current?.cache_mode ?? null,
            max_size_bytes: current?.max_size_bytes ?? null,
            max_age_seconds: current?.max_age_seconds ?? null,
            ...patch
        }
        feedPolicies.value = { ...feedPolicies.value, [feedId]: updated }
        const db = getDb()
        if (!db) return
        try {
            await upsertFeedCachePolicy(db, feedId, updated)
        } catch (err) {
            console.error(
                '[feed-reader] feed policy save failed',
                err instanceof Error ? err.message : ''
            )
        }
    }

    function handleFeedCacheModeChange (feedId:number) {
        return (ev:Event) => {
            const val = (ev.target as HTMLSelectElement).value
            const mode = (val === 'text' || val === 'text_images') ?
                val as CacheMode :
                null
            saveFeedPolicy(feedId, { cache_mode: mode })
        }
    }

    function handleFeedMaxSizeChange (feedId:number) {
        return (ev:Event) => {
            const raw = (ev.target as HTMLInputElement).value.trim()
            const mb = raw === '' ? null : parseFloat(raw)
            const bytes = (mb !== null && isFinite(mb) && mb >= 1) ?
                Math.round(mb * 1_000_000) :
                null
            saveFeedPolicy(feedId, { max_size_bytes: bytes })
        }
    }

    function handleFeedMaxAgeChange (feedId:number) {
        return (ev:Event) => {
            const raw = (ev.target as HTMLInputElement).value.trim()
            const days = raw === '' ? null : parseFloat(raw)
            const secs = (days !== null && isFinite(days) && days >= 1) ?
                Math.round(days * 86400) :
                null
            saveFeedPolicy(feedId, { max_age_seconds: secs })
        }
    }

    function handleClearFeedCache (feedId:number, feedTitle:string) {
        return async (e:Event) => {
            e.preventDefault()
            if (!confirm(
                `Clear cached content for "${feedTitle}"? ` +
                'This will free space but article content will need ' +
                'to be re-fetched.'
            )) return
            const db = getDb()
            if (!db) return
            try {
                await clearFeedCache(db, feedId)
                const ids = feeds.value.map(f => f.id)
                await loadStorageUsage(db, ids)
            } catch (err) {
                console.error(
                    '[feed-reader] clear feed cache failed',
                    err instanceof Error ? err.message : ''
                )
            }
        }
    }

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
                            ${(() => {
                                const policy = feedPolicies.value[
                                    selectedFeed.id
                                ] ?? null
                                const eff = resolveEffectivePolicy(policy)
                                const modeLabel = (eff.cacheMode === 'text' ?
                                    'Text only' :
                                    'Text + images')
                                const sizeVal = policy?.max_size_bytes != null ?
                                    String(Math.round(
                                        policy.max_size_bytes / 1_000_000
                                    )) :
                                    ''
                                const ageVal = policy?.max_age_seconds != null ?
                                    String(Math.round(
                                        policy.max_age_seconds / 86400
                                    )) :
                                    ''
                                return html`
                                    <details class="feed-cache-controls">
                                        <summary>
                                            Cache:${NBSP}
                                            ${modeLabel}${
                                                eff.isDefault.cacheMode ?
                                                    ' (default)' :
                                                    ''
                                            }
                                        </summary>
                                        <div class="feed-cache-form">
                                            <label class="cache-field-label">
                                                Cache mode
                                                <select
                                                    name=${`feed-cache-mode-${selectedFeed.id}`}
                                                    onChange=${handleFeedCacheModeChange(
                                                        selectedFeed.id
                                                    )}
                                                >
                                                    <option
                                                        value=""
                                                        selected=${
                                                            policy?.cache_mode ==
                                                            null
                                                        }
                                                    >
                                                        Use default
                                                    </option>
                                                    <option
                                                        value="text"
                                                        selected=${
                                                            policy?.cache_mode ===
                                                            'text'
                                                        }
                                                    >
                                                        Text only
                                                    </option>
                                                    <option
                                                        value="text_images"
                                                        selected=${
                                                            policy?.cache_mode ===
                                                            'text_images'
                                                        }
                                                    >
                                                        Text + images
                                                    </option>
                                                </select>
                                            </label>
                                            <label class="cache-field-label">
                                                Max size (MB, blank = default)
                                                <input
                                                    type="number"
                                                    name=${`feed-max-size-${selectedFeed.id}`}
                                                    min="1"
                                                    value=${sizeVal}
                                                    placeholder="default"
                                                    onChange=${handleFeedMaxSizeChange(
                                                        selectedFeed.id
                                                    )}
                                                />
                                            </label>
                                            <label class="cache-field-label">
                                                Keep for (days, blank = default)
                                                <input
                                                    type="number"
                                                    name=${`feed-max-age-${selectedFeed.id}`}
                                                    min="1"
                                                    value=${ageVal}
                                                    placeholder="default"
                                                    onChange=${handleFeedMaxAgeChange(
                                                        selectedFeed.id
                                                    )}
                                                />
                                            </label>
                                        </div>
                                        <button
                                            class="btn-clear-cache"
                                            onClick=${handleClearFeedCache(
                                                selectedFeed.id,
                                                selectedFeed.title ||
                                                    selectedFeed.url
                                            )}
                                        >
                                            Clear cache
                                        </button>
                                    </details>
                                `
                            })()}
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

                        ${!itemsLoading.value && items.value.length === 0 && html`
                            <div class="empty-state">
                                ${feeds.value.length === 0 ?
                                    'Maybe add some feeds to start reading.' :
                                    selectedFeed ?
                                        `No items in ${selectedFeed.title || selectedFeed.url}` :
                                        'No items to show.'}
                            </div>
                        `}
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
