import { type FunctionComponent } from 'preact'
import { html, useCallback } from 'htm/preact'
import { decodeEntities, formatDate, stripHtml } from '../util.js'
import { MailOpened } from './mail-opened.js'
import '@substrate-system/tool-tip'
import {
    State,
    type AppState,
    type Item,
} from '../state.js'
import './item-row.css'
import '@substrate-system/icons/css'
import { define } from '@substrate-system/icons/new-tab'
import { MailSpark } from './mail-spark.js'
define()

export const ItemRow:FunctionComponent<{
    item:Item
    state:AppState
}> = function ItemRow ({ item, state }) {
    const isUnread = !item.is_read
    const isStarred = !!item.is_starred
    const isOnline = state.isOnline.value

    const toggleRead = useCallback((ev:MouseEvent) => {
        ev.preventDefault()
        State.toggleItemRead(state, item.id, !item.is_read)
    }, [])

    const handleStar = useCallback(async (ev:MouseEvent) => {
        ev.stopPropagation()
        if (!isOnline) return
        await State.toggleItemStarred(state, item.id, !isStarred)
    }, [])

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

            <div class="item-controls">
                <div class="item-actions">
                    <a href="${item.link}" target="_blank" class="icon">
                        <new-tab></new-tab>
                        <span class="visually-hidden">New Tab</span>
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
                        <span class="visually-hidden">star</span>
                    </button>
                </div>

                <div class="item-actions">
                    <button class="icon" onClick=${toggleRead}>
                        ${item.is_read ?
                            // is read, so click marks it unread
                            html`
                                <tool-tip content="Mark unread" placement="left">
                                    <${MailSpark} />
                                </tool-tip>
                                <span class="visually-hidden">
                                    Mark as unread
                                </span>
                            ` :
                            // not read, mark as read
                            html`
                                <tool-tip content="Mark as read" placement="left-start">
                                    <${MailOpened} />
                                </tool-tip>
                                <span class="visually-hidden">Mark as read</span>
                            `
                        }
                    </button>
                </div>
            </div>
        </div>
    `
}
