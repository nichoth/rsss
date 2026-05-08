import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { signal, type Signal } from '@preact/signals'
import { type AppState, State } from '../state.js'
import { Button } from '../components/button.js'
import './updates.css'

interface PendingItem {
    id:string
    title:string
    published_at:string
}

interface FeedPreview {
    loading:boolean
    items:PendingItem[]
    error:string|null
}

type PreviewMap = Map<string, Signal<FeedPreview>>
type RefreshMap = Map<string, {
    error:Signal<string|null>
}>

async function fetchPreview (
    feedId:string,
    sig:Signal<FeedPreview>
):Promise<void> {
    sig.value = { loading: true, items: [], error: null }
    try {
        const res = await fetch(`/api/feeds/${feedId}/pending`, {
            credentials: 'include'
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json() as { items:PendingItem[] }
        sig.value = { loading: false, items: data.items, error: null }
    } catch (err) {
        sig.value = {
            loading: false,
            items: [],
            error: err instanceof Error ? err.message : 'Failed to load'
        }
    }
}

const FeedRow:FunctionComponent<{
    feedId:string
    title:string
    previewMap:PreviewMap
    refreshMap:RefreshMap
    state:AppState
}> = function ({ feedId, title, previewMap, refreshMap, state }) {
    if (!previewMap.has(feedId)) {
        previewMap.set(feedId, signal<FeedPreview>({
            loading: false,
            items: [],
            error: null
        }))
    }
    if (!refreshMap.has(feedId)) {
        refreshMap.set(feedId, {
            error: signal<string|null>(null)
        })
    }
    const preview = previewMap.get(feedId)!
    const refresh = refreshMap.get(feedId)!

    function handleToggle (ev:Event) {
        const details = ev.currentTarget as HTMLDetailsElement
        if (!details.open) return
        if (!preview.value.loading && preview.value.items.length === 0
            && preview.value.error === null) {
            fetchPreview(feedId, preview)
        }
    }

    async function handleRefresh () {
        refresh.error.value = null
        try {
            await State.refreshFeed(state, feedId)
        } catch (err) {
            refresh.error.value = err instanceof Error ?
                err.message :
                'Refresh failed'
        }
    }

    const pv = preview.value

    return html`
        <li class="updates-feed-item" key=${feedId}>
            <details onToggle=${handleToggle}>
                <summary class="feed-summary">
                    <span class="feed-title">${title}</span>
                    <${Button}
                        onClick=${handleRefresh}
                        class="btn-refresh"
                    >
                        Refresh
                    <//>
                </summary>
                ${refresh.error.value && html`
                    <p class="refresh-error">${refresh.error.value}</p>
                `}
                <div class="pending-preview">
                    ${pv.loading && html`
                        <p class="preview-loading">Loading...</p>
                    `}
                    ${pv.error && html`
                        <p class="preview-error">${pv.error}</p>
                    `}
                    ${!pv.loading && !pv.error && pv.items.length === 0 &&
                        html`<p class="preview-empty">No pending items.</p>`
                    }
                    ${!pv.loading && pv.items.length > 0 && html`
                        <ul class="pending-items">
                            ${pv.items.map(item => html`
                                <li key=${item.id} class="pending-item">
                                    <span class="item-title">
                                        ${item.title || '(no title)'}
                                    </span>
                                    <span class="item-date">
                                        ${new Date(
                                            item.published_at
                                        ).toLocaleString()}
                                    </span>
                                </li>
                            `)}
                        </ul>
                    `}
                </div>
            </details>
        </li>
    `
}

export const UpdatesRoute:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const previewMapRef = useRef<PreviewMap>(new Map())
    const refreshMapRef = useRef<RefreshMap>(new Map())

    useEffect(() => {
        if (!state.authLoading.value && !state.isAuthenticated.value) {
            state._setRoute('/login')
        }
    }, [state.authLoading.value, state.isAuthenticated.value])

    if (!state.isAuthenticated.value) return null

    const pendingIds = state.feedsWithUpdates.value
    const feeds = state.feeds.value

    const pendingFeeds = pendingIds.map(id => {
        const feed = feeds.find(f => String(f.id) === id)
        return { id, title: feed?.title || feed?.url || id }
    })

    return html`
        <div class="route updates">
            <header class="updates-header">
                <a href="/" class="back-link">${'<'} Back to Feeds</a>
                <h1>Pending Updates</h1>
            </header>

            ${pendingFeeds.length === 0 ?
                html`<p class="empty-state">
                    All feeds are up to date.
                </p>` :
                html`<ul class="updates-feed-list">
                    ${pendingFeeds.map(f => html`
                        <${FeedRow}
                            feedId=${f.id}
                            title=${f.title}
                            previewMap=${previewMapRef.current}
                            refreshMap=${refreshMapRef.current}
                            state=${state}
                        />
                    `)}
                </ul>`
            }
        </div>
    `
}
