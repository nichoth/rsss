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

    return html.slice(0, headClose) + script + html.slice(headClose)
}
