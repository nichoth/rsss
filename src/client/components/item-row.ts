import { type FunctionComponent } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { html } from 'htm/preact'
import { BlurHash } from '@substrate-system/blur-hash'
import { decodeEntities, formatDate, stripHtml } from '../util.js'
import { MailOpened } from './mail-opened.js'
import '@substrate-system/tool-tip'
import {
    State,
    itemToRoute,
    type AppState,
    type Item,
} from '../state.js'
import './item-row.css'
import '@substrate-system/icons/css'
import { define } from '@substrate-system/icons/new-tab'
import { MailSpark } from './mail-spark.js'
define()
BlurHash.define()

function isValidImageSize (value:number|null|undefined):value is number {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value > 0
}

export const ItemRow:FunctionComponent<{
    item:Item
    state:AppState
}> = function ItemRow ({ item, state }) {
    const isUnread = !item.is_read
    const isStarred = !!item.is_starred
    const [hiddenThumbnail, setHiddenThumbnail] = useState(false)
    const imageUrl = item.og_image_url?.trim()
    const imageWidth = item.image_width
    const imageHeight = item.image_height
    const hasBlurHash = Boolean(
        item.blurhash &&
        isValidImageSize(imageWidth) &&
        isValidImageSize(imageHeight)
    )
    const showThumbnail = Boolean(
        imageUrl && !hiddenThumbnail
    )
    const imageAlt = item.title ?
        decodeEntities(item.title + '') :
        'Article image'

    useEffect(() => {
        setHiddenThumbnail(false)
    }, [imageUrl])

    const toggleRead = useCallback((ev:MouseEvent) => {
        ev.preventDefault()
        State.toggleItemRead(state, item.id, !item.is_read)
    }, [])

    const handleStar = useCallback(async (
        ev:MouseEvent
    ) => {
        ev.stopPropagation()
        await State.toggleItemStarred(
            state,
            item.id,
            !isStarred
        )
    }, [])

    const handleThumbnailError = useCallback(() => {
        setHiddenThumbnail(true)
    }, [])

    const route = itemToRoute(item)
    return html`
        <div class="item-row ${isUnread ? 'unread' : ''}">
            <a
                class="item-link ${showThumbnail ?
                    'with-thumbnail' :
                    ''}"
                href=${route}
            >
                ${showThumbnail && html`
                    ${hasBlurHash ?
                        html`
                            <blur-hash
                                class="item-thumbnail"
                                placeholder=${item.blurhash}
                                src=${imageUrl}
                                width=${imageWidth}
                                height=${imageHeight}
                                alt=${imageAlt}
                                loading="lazy"
                            ></blur-hash>
                        ` :
                        html`
                            <img
                                class="item-thumbnail"
                                src=${imageUrl}
                                loading="lazy"
                                decoding="async"
                                referrerpolicy="no-referrer"
                                alt=${imageAlt}
                                onError=${handleThumbnailError}
                            />
                        `
                    }
                `}
                <div class="item-main">
                    <h3 class="item-title">
                        ${item.title ?
                            decodeEntities(item.title + '') :
                            '(No title)'
                        }
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
                            ${stripHtml(
                                item.description
                            ).slice(0, 200)}
                        </p>
                    `}
                </div>
            </a>

            <div class="item-controls">
                <div class="item-actions">
                    <a
                        href="${item.link}"
                        target="_blank"
                        class="icon"
                    >
                        <new-tab></new-tab>
                        <span class="visually-hidden">
                            New Tab
                        </span>
                    </a>
                    <button
                        class="btn-star ${isStarred ?
                            'starred' :
                            ''}"
                        onClick=${handleStar}
                        title=${isStarred ? 'Unstar' : 'Star'}
                    >
                        ${isStarred ? '\u2605' : '\u2606'}
                        <span class="visually-hidden">
                            star
                        </span>
                    </button>

                    <button
                        class="icon"
                        onClick=${toggleRead}
                    >
                        ${item.is_read ?
                            html`
                                <tool-tip
                                    content="Mark unread"
                                    delay="500"
                                    placement="left"
                                >
                                    <${MailSpark} />
                                </tool-tip>
                                <span class="visually-hidden">
                                    Mark as unread
                                </span>
                            ` :
                            html`
                                <tool-tip
                                    content="Mark as read"
                                    delay="500"
                                    placement="left-start"
                                >
                                    <${MailOpened} />
                                </tool-tip>
                                <span class="visually-hidden">
                                    Mark as read
                                </span>
                            `
                        }
                    </button>
                </div>
            </div>
        </div>
    `
}
