import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useComputed } from '@preact/signals'
import { type Item, type AppState, State } from '../state.js'
import './item-reader.css'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:view')

export const ItemReader:FunctionComponent<{
    state:AppState;
    splats:string[];
}> = function ItemReader ({ state, splats }) {
    const itemUrl = splats.shift()

    const itemSignal = useComputed<undefined|null|Item>(() => {
        if (!state.items.value.length) return null
        return state.items.value.find(i => i.link?.includes(itemUrl!))
    })

    const item = itemSignal.value
    if (!item) {
        return html`<p>oh no</p>`
    }

    const isStarred = !!item.is_starred
    const isRead = !!item.is_read
    const isOnline = state.isOnline.value

    async function handleStar () {
        if (!isOnline) return
        await State.toggleItemStarred(state, item!.id, !isStarred)
    }

    async function handleToggleRead () {
        if (!isOnline) return
        await State.toggleItemRead(state, item!.id, !isRead)
    }

    return html`
        <div class="route item-reader">
            <header class="reader-header">
                <a class="btn btn-back" href="/">
                    ${'<'} Back
                </a>
                <div class="reader-actions">
                    <button
                        class="btn btn-icon ${isStarred ? 'starred' : ''}"
                        onClick=${handleStar}
                        title=${isOnline ?
                            (isStarred ? 'Unstar' : 'Star') :
                            'Cannot star while offline'}
                        disabled=${!isOnline}
                    >
                        ${isStarred ? '★' : '☆'}
                    </button>
                    <button
                        class="btn btn-small"
                        onClick=${handleToggleRead}
                        disabled=${!isOnline}
                        title=${isOnline ?
                            '' :
                            'Cannot change read status while offline'}
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

                <div class="article-body"
                    dangerouslySetInnerHTML=${{ __html: sanitizeHtml(item.content || item.description || '') }}
                ></div>
            </article>
        </div>
    `
}

function sanitizeHtml (html: string): string {
    // Basic sanitization - remove script tags and event handlers
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/\s*on\w+="[^"]*"/gi, '')
        .replace(/\s*on\w+='[^']*'/gi, '')
        .replace(/javascript:/gi, '')
}

function formatDate (dateStr:string|null):string {
    if (!dateStr) return ''
    return new Date(dateStr).toLocaleString()
}
