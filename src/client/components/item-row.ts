import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import {
    State,
    type AppState,
    type Item,
} from '../state.js'

export const ItemRow:FunctionComponent<{
    item:Item
    state:AppState
    onClick:()=>void
}> = function ItemRow ({ item, state }) {
    const isUnread = !item.is_read
    const isStarred = !!item.is_starred
    const isOnline = state.isOnline.value

    async function handleStar (e: Event) {
        e.stopPropagation()
        if (!isOnline) return
        await State.toggleItemStarred(state, item.id, !isStarred)
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

    const route = State.itemToRoute(item)
    return html`
        <article class="item-row ${isUnread ? 'unread' : ''}">
            <a class="item-link" href=${route}>
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
            </a>
            <div class="item-actions">
                <button
                    class="btn-star ${isStarred ? 'starred' : ''}"
                    onClick=${handleStar}
                    title=${isOnline ? (isStarred ? 'Unstar' : 'Star') : 'Cannot star while offline'}
                    disabled=${!isOnline}
                >
                    ${isStarred ? '★' : '☆'}
                </button>
            </div>
        </article>
    `
}

function stripHtml (html: string): string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}
