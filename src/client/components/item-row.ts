import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { decodeEntities, formatDate, stripHtml } from '../util.js'
import {
    State,
    type AppState,
    type Item,
} from '../state.js'
import './item-row.css'
import '@substrate-system/icons/css'
import { define } from '@substrate-system/icons/new-tab'
define()

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

    const route = State.itemToRoute(item)
    return html`
        <div class="item-row ${isUnread ? 'unread' : ''}">
            <a class="item-link" href=${route}>
                <div class="item-main">
                    <h3 class="item-title">
                        ${decodeEntities(item.title + '') || '(No title)'}
                    </h3>
                    <div class="item-meta">
                        <span class="item-feed">
                            ${item.feed_title}
                        </span>
                        ${item.pub_date && html`
                            <time class="item-date" datetime="${
                                new Date(item.pub_date)
                                    .toISOString()
                                    .split('T')
                                    .shift()
                            }">
                                ${formatDate(item.pub_date)}
                            </time>
                        `}
                    </div>
                    ${item.description && html`
                        <p class="item-excerpt">
                            ${stripHtml(item.description).slice(0, 200)}
                        </p>
                    `}
                </div>
            </a>

            <div class="item-actions">
                <a href="${item.link}" target="_blank">
                    <new-tab></new-tab>
                </a>
                <button
                    class="btn-star ${isStarred ? 'starred' : ''}"
                    onClick=${handleStar}
                    title=${isOnline ?
                        (isStarred ? 'Unstar' : 'Star') :
                        'Cannot star while offline'}
                    disabled=${!isOnline}
                >
                    ${isStarred ? '★' : '☆'}
                </button>
            </div>
        </div>
    `
}
