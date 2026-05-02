import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useCallback, useEffect } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { NotFound } from '../not-found.js'
import { formatDate, sanitizeHtml } from '../util.js'
import {
    type Item,
    type AppState,
    State,
    findItemByRoute,
    isItemRoute,
    articleFetchingItemId,
    articleFetchError
} from '../state.js'
import { isSummaryOnly } from '../../shared/article-detect.js'
import {
    publisherLinkLabel,
    publisherLinkHref
} from '../../shared/publisher-link.js'
import './item-reader.css'
import Debug from '@substrate-system/debug'
const debug = Debug('rsss:view')

export const ItemReader:FunctionComponent<{
    state:AppState;
    splats:string[];
}> = function ItemReader ({ state }) {
    debug('reading...', state.route.value)

    const itemSignal = useComputed<
        undefined|null|Item
    >(() => {
        if (!isItemRoute(state.route.value)) return null
        return (
            findItemByRoute(state, state.route.value) ||
            state.routeItem.value
        )
    })

    const item = itemSignal.value
    const isLoadingItem = (
        state.routeItemLoading.value &&
        !item
    )

    if (isLoadingItem) {
        return html`
            <div class="route item-reader">
                <p class="loading-text">Loading post...</p>
            </div>
        `
    }
    if (!item) return html`<${NotFound} />`

    const itemId = item.id
    const isStarred = !!item.is_starred
    const isRead = !!item.is_read
    const articleHtml = sanitizeHtml(
        item.full_content ||
        item.content ||
        item.description ||
        ''
    )
    const contentUnavailable = (
        !articleHtml &&
        navigator.onLine === false
    )
    const isFetching = articleFetchingItemId.value === itemId
    const fetchFailed = (
        typeof item.full_content_status === 'string' &&
        item.full_content_status.startsWith('failed_')
    )
    const fetchErrorMessage = (
        articleFetchError.value &&
        articleFetchError.value.itemId === itemId
    ) ? articleFetchError.value.message : null

    const handleRetry = useCallback(async () => {
        await State.fetchFullArticle(state, itemId, { force: true })
    }, [itemId])

    useEffect(() => {
        if (item.full_content_status != null) return
        if (!isSummaryOnly(item)) return
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return
        }
        State.fetchFullArticle(state, itemId)
    }, [
        itemId,
        item.full_content_status,
        item.link,
        item.content,
        item.description
    ])

    const handleStar = useCallback(async () => {
        await State.toggleItemStarred(
            state,
            itemId,
            !isStarred
        )
    }, [itemId, isStarred])

    async function handleToggleRead () {
        await State.toggleItemRead(
            state,
            itemId,
            !isRead
        )
    }

    return html`
        <div class="route item-reader">
            <header class="reader-header">
                <a class="btn btn-back" href="/">
                    ${'<'} Back
                </a>
                <div class="reader-actions">
                    <button
                        class="btn btn-icon ${
                            isStarred ? 'starred' : ''
                        }"
                        onClick=${handleStar}
                        title=${isStarred ?
                            'Unstar' :
                            'Star'}
                    >
                        ${isStarred ? '\u2605' : '\u2606'}
                    </button>
                    <button
                        class="btn btn-small"
                        onClick=${handleToggleRead}
                    >
                        ${isRead ?
                            'Mark unread' :
                            'Mark read'}
                    </button>
                </div>
            </header>

            <article class="reader-content">
                <header class="article-header">
                    <h1>${item.title || '(No title)'}</h1>
                    <div class="article-meta">
                        <span class="article-feed">
                            ${item.feed_title}
                        </span>
                            ${item.author && html`<span
                                class="article-author"
                            >
                                by ${item.author}
                        </span>`}
                        ${item.pub_date && html`<span
                            class="article-date"
                        >
                            ${formatDate(item.pub_date)}
                        </span>`}
                    </div>
                </header>

                ${isFetching && html`
                    <p class="article-fetch-status">
                        Fetching full article…
                    </p>
                `}

                ${(!isFetching && fetchFailed) && html`
                    <p class="article-fetch-status failed">
                        Couldn't load the full article.
                        ${fetchErrorMessage && html`
                            <span class="article-fetch-detail">
                                ${' '}(${fetchErrorMessage})
                            </span>
                        `}
                        <button
                            type="button"
                            class="btn btn-small article-fetch-retry"
                            onClick=${handleRetry}
                        >
                            Retry
                        </button>
                    </p>
                `}

                ${contentUnavailable ? html`
                    <div class="article-body article-unavailable">
                        Article content unavailable offline.
                    </div>
                ` : html`
                    <div
                        class="article-body"
                        dangerouslySetInnerHTML=${{
                            __html: articleHtml
                        }}
                    ></div>
                `}

                ${item.link && (() => {
                    const label = publisherLinkLabel(item.link)
                    const href = publisherLinkHref(item.link)
                    if (!label || !href) return null
                    return html`
                        <p class="article-publisher-link">
                            <a
                                href=${href}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                ${label}
                            </a>
                        </p>
                    `
                })()}
            </article>
        </div>
    `
}

