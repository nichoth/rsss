import type { Item } from '../client/db/types.js'

export interface InitialFeedPayload {
    version:number
    items:Item[]
    has_more:boolean
}

export function buildLazyHtmlCacheKey (
    did:string,
    version:number
):string {
    return `html:${did}:${version}`
}

export function serializeInitialFeed (
    payload:InitialFeedPayload
):string {
    return JSON.stringify(payload).replace(/</g, '\\u003c')
}

export function injectInitialFeed (
    html:string,
    payload:InitialFeedPayload
):string {
    const headClose = html.indexOf('</head>')

    if (headClose === -1) {
        return html
    }

    const script = (
        '<script id="initial-feed" type="application/json">' +
        serializeInitialFeed(payload) +
        '</script>'
    )

    const withScript = html.slice(0, headClose) + script +
        html.slice(headClose)

    return injectInitialFeedMarkup(withScript, payload)
}

function injectInitialFeedMarkup (
    html:string,
    payload:InitialFeedPayload
):string {
    const root = '<div id="root"></div>'
    const rootIndex = html.indexOf(root)

    if (rootIndex === -1 || payload.items.length === 0) {
        return html
    }

    const seededRoot = (
        '<div id="root">' +
        '<div class="route feed-reader">' +
        '<div class="app-body">' +
        '<main class="content">' +
        '<ul class="items-list">' +
        payload.items.map(renderInitialFeedItem).join('') +
        '</ul>' +
        '</main>' +
        '</div>' +
        '</div>' +
        '</div>'
    )

    return html.slice(0, rootIndex) + seededRoot +
        html.slice(rootIndex + root.length)
}

function renderInitialFeedItem (
    item:Item
):string {
    const title = item.title ? escapeHtml(item.title + '') : '(No title)'
    const unread = item.is_read ? '' : ' unread'

    return (
        '<li>' +
        `<div class="item-row${unread}">` +
        renderInitialFeedLink(item, title) +
        '</div>' +
        '</li>'
    )
}

function renderInitialFeedLink (
    item:Item,
    title:string
):string {
    const image = renderInitialFeedImage(item, title)
    const hasImage = image ? ' with-thumbnail' : ''
    const href = escapeAttribute(itemRoute(item) ?? '#')
    const feedTitle = escapeHtml(item.feed_title ?? '')

    return (
        `<a class="item-link${hasImage}" href="${href}">` +
        image +
        '<div class="item-main">' +
        `<h3 class="item-title">${title}</h3>` +
        '<div class="item-meta">' +
        `<span class="item-feed">${feedTitle}</span>` +
        renderInitialFeedDate(item.pub_date) +
        '</div>' +
        renderInitialFeedExcerpt(item.description) +
        '</div>' +
        '</a>'
    )
}

function renderInitialFeedImage (
    item:Item,
    title:string
):string {
    const src = item.og_image_url?.trim()

    if (!src) return ''

    const alt = escapeAttribute(title)
    const imageWidth = item.image_width
    const imageHeight = item.image_height
    const hasBlurHash = Boolean(
        item.blurhash &&
        isValidImageSize(imageWidth) &&
        isValidImageSize(imageHeight)
    )

    if (hasBlurHash) {
        return (
            '<blur-hash class="item-thumbnail" ' +
            `placeholder="${escapeAttribute(item.blurhash ?? '')}" ` +
            `src="${escapeAttribute(src)}" ` +
            `width="${imageWidth}" ` +
            `height="${imageHeight}" ` +
            `alt="${alt}" ` +
            'loading="lazy"></blur-hash>'
        )
    }

    return (
        '<img class="item-thumbnail" ' +
        `src="${escapeAttribute(src)}" ` +
        'loading="lazy" ' +
        'decoding="async" ' +
        'referrerpolicy="no-referrer" ' +
        `alt="${alt}" />`
    )
}

function renderInitialFeedDate (
    pubDate:string|null
):string {
    if (!pubDate) return ''

    const date = new Date(pubDate)

    if (Number.isNaN(date.getTime())) return ''

    return (
        `<time class="item-date" datetime="${
            escapeAttribute(date.toISOString().split('T')[0])
        }">` +
        escapeHtml(date.toLocaleDateString()) +
        '</time>'
    )
}

function renderInitialFeedExcerpt (
    description:string|null
):string {
    if (!description) return ''

    return '<p class="item-excerpt">' +
        escapeHtml(description.replace(/<[^>]*>/g, '').slice(0, 200)) +
        '</p>'
}

function itemRoute (
    item:Item
):string|null {
    if (!item.link) return null

    try {
        const url = new URL(item.link)
        return '/post/' + url.host + url.pathname + url.search + url.hash
    } catch {
        return null
    }
}

function isValidImageSize (
    value:number|null|undefined
):value is number {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value > 0
}

function escapeHtml (
    value:string
):string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function escapeAttribute (
    value:string
):string {
    return escapeHtml(value)
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}
