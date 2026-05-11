import type {
    CountsResponse,
    Feed,
    Item
} from '../client/db/types.js'
import {
    buildLazyHtmlCacheKey,
    injectInitialFeed,
    type InitialFeedPayload
} from './lazy-html.js'

const HTML_CONTENT_TYPE = 'text/html;charset=utf-8'
const HTML_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30

export interface LazyHtmlInput {
    did:string
    kv:KVNamespace
    doStub:DurableObjectStub
    assets:Fetcher
    request:Request
}

interface FeedVersionResponse {
    version:number
}

interface LazyHtmlDataResponse {
    version:number
    items:Item[]
    feeds:Feed[]
    counts:CountsResponse
}

export async function handleLazyHtmlRequest (
    input:LazyHtmlInput
):Promise<Response> {
    if (!wantsHtml(input.request)) {
        return input.assets.fetch(input.request)
    }

    const versionResponse = await input.doStub.fetch(
        internalRequest(input.request, '/internal/feed-version')
    )

    if (!versionResponse.ok) {
        return input.assets.fetch(input.request)
    }

    const { version } = await versionResponse.json() as FeedVersionResponse
    const key = buildLazyHtmlCacheKey(input.did, version)
    const cached = await input.kv.get(key, 'text')

    if (cached !== null) {
        return htmlResponse(cached)
    }

    const dataResponse = await input.doStub.fetch(
        internalRequest(input.request, '/internal/lazy-html-data')
    )

    if (!dataResponse.ok) {
        return input.assets.fetch(input.request)
    }

    const data = await dataResponse.json() as LazyHtmlDataResponse
    const shellResponse = await input.assets.fetch(
        internalRequest(input.request, '/index.html')
    )

    if (!shellResponse.ok) {
        return shellResponse
    }

    const payload:InitialFeedPayload = {
        version: data.version,
        items: data.items,
        has_more: data.items.length >= 50,
        feeds: data.feeds,
        counts: data.counts
    }
    const html = injectInitialFeed(await shellResponse.text(), payload)

    await input.kv.put(key, html, {
        expirationTtl: HTML_CACHE_TTL_SECONDS
    })

    return htmlResponse(html)
}

function wantsHtml (
    request:Request
):boolean {
    if (request.method !== 'GET') {
        return false
    }

    return request.headers.get('accept')?.includes('text/html') ?? false
}

function internalRequest (
    request:Request,
    pathname:string
):Request {
    return new Request(new URL(pathname, request.url), {
        method: 'GET',
        headers: request.headers
    })
}

function htmlResponse (
    html:string
):Response {
    return new Response(html, {
        headers: { 'content-type': HTML_CONTENT_TYPE }
    })
}
