import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useCallback } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { NotFound } from '../not-found.js'
import { formatDate, sanitizeHtml } from '../util.js'
import {
    type Item,
    type AppState,
    State,
    findItemByRoute,
    isItemRoute
} from '../state.js'
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
        item.content ||
        item.description ||
        ''
    )
    const contentUnavailable = (
        !articleHtml &&
        navigator.onLine === false
    )

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
            </article>
        </div>
    `
}
