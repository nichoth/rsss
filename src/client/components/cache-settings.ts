import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { DetailsSummary } from '@substrate-system/details-summary'
import { type AppState } from '../state.js'
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
    clearFeedCache,
    type Feed
} from '../db/index.js'
import { loadStorageUsage } from '../db/storage-usage.js'
import { AMP, NBSP } from '../constants.js'

export const CacheSettings:FunctionComponent<{
    state:AppState;
    selectedFeed:Feed;
}> = function CacheSettings ({ state, selectedFeed }) {
    const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        setPrefersReducedMotion(mq.matches)
        const onChange = (ev:MediaQueryListEvent) => {
            setPrefersReducedMotion(ev.matches)
        }
        mq.addEventListener('change', onChange)
        return () => {
            mq.removeEventListener('change', onChange)
        }
    }, [])

    useEffect(() => {
        const db = getDb()
        if (!db) return
        loadFeedPolicies(db, [selectedFeed.id]).catch(() => {})
    }, [selectedFeed.id])

    function getDb () {
        const did = state.user.value?.did
        return did ?
            (getBootstrappedDb() ?? getLocalDb(did)) :
            null
    }

    async function saveFeedPolicy (
        patch:Partial<FeedCachePolicyRow>
    ):Promise<void> {
        const feedId = selectedFeed.id
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
                '[cache-settings] feed policy save failed',
                err instanceof Error ? err.message : ''
            )
        }
    }

    function handleCacheModeChange (ev:Event) {
        const val = (ev.target as HTMLSelectElement).value
        const mode = (val === 'text' || val === 'text_images') ?
            val as CacheMode :
            null
        saveFeedPolicy({ cache_mode: mode })
    }

    function handleMaxSizeChange (ev:Event) {
        const raw = (ev.target as HTMLInputElement).value.trim()
        const mb = raw === '' ? null : parseFloat(raw)
        const bytes = (mb !== null && isFinite(mb) && mb >= 1) ?
            Math.round(mb * 1_000_000) :
            null
        saveFeedPolicy({ max_size_bytes: bytes })
    }

    function handleMaxAgeChange (ev:Event) {
        const raw = (ev.target as HTMLInputElement).value.trim()
        const days = raw === '' ? null : parseFloat(raw)
        const secs = (days !== null && isFinite(days) && days >= 1) ?
            Math.round(days * 86400) :
            null
        saveFeedPolicy({ max_age_seconds: secs })
    }

    async function handleClearCache (e:Event) {
        e.preventDefault()
        const label = selectedFeed.title || selectedFeed.url
        if (!confirm(
            `Clear cached content for "${label}"? ` +
            'This will free space but article content will need ' +
            'to be re-fetched.'
        )) return
        const db = getDb()
        if (!db) return
        try {
            await clearFeedCache(db, selectedFeed.id)
            const ids = state.feeds.value.map(f => f.id)
            await loadStorageUsage(db, ids)
        } catch (err) {
            console.error(
                '[cache-settings] clear feed cache failed',
                err instanceof Error ? err.message : ''
            )
        }
    }

    const policy = feedPolicies.value[selectedFeed.id] ?? null
    const eff = resolveEffectivePolicy(policy)
    const modeLabel = (eff.cacheMode === 'text' ?
        'Text only' :
        `Text ${AMP} images`)
    const sizeVal = policy?.max_size_bytes != null ?
        String(Math.round(policy.max_size_bytes / 1_000_000)) :
        ''
    const ageVal = policy?.max_age_seconds != null ?
        String(Math.round(policy.max_age_seconds / 86400)) :
        ''

    return html`
        <${DetailsSummary.TAG}
            class="feed-cache-controls"
            key=${selectedFeed.id}
            duration=${prefersReducedMotion ? '0' : undefined}
        >
            <details>
                <summary>
                    Cache:${NBSP}${modeLabel}${
                        eff.isDefault.cacheMode ? ' (default)' : ''
                    }
                </summary>
                <div class="details-content">
                    <div class="feed-cache-form">
                        <label class="cache-field-label">
                            Cache mode
                            <select
                                name=${`feed-cache-mode-${selectedFeed.id}`}
                                onChange=${handleCacheModeChange}
                            >
                                <option
                                    value=""
                                    selected=${policy?.cache_mode == null}
                                >
                                    Use default
                                </option>
                                <option
                                    value="text"
                                    selected=${policy?.cache_mode === 'text'}
                                >
                                    Text only
                                </option>
                                <option
                                    value="text_images"
                                    selected=${
                                        policy?.cache_mode === 'text_images'
                                    }
                                >
                                    Text ${AMP} images
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
                                onChange=${handleMaxSizeChange}
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
                                onChange=${handleMaxAgeChange}
                            />
                        </label>
                    </div>
                    <button
                        class="btn-clear-cache"
                        onClick=${handleClearCache}
                    >
                        Clear cache
                    </button>
                </div>
            </details>
        <//>
    `
}
