/**
 * Server-side pipeline that fetches an article URL, validates the
 * response, reads it within the byte cap, and runs the extractor.
 *
 * Returns a discriminated result whose `status` matches the
 * FullContentStatus enum exactly so the caller can write it straight
 * to `items.full_content_status`.
 */

import {
    ARTICLE_FETCH_TIMEOUT_MS,
    MAX_ARTICLE_FETCH_BYTES,
    type FullContentStatus
} from '../shared/schema.js'
import {
    fetchValidatedResponse,
    FeedFetchError,
    MAX_ARTICLE_REDIRECTS,
    type FetchFeedTextOptions
} from './feed-fetch.js'
import { extractArticleBody } from './article-extract.js'

export type FetchFullArticleResult =
    | { status:'succeeded', html:string, fetchedAt:string }
    | { status:Exclude<FullContentStatus, 'succeeded'> }

function isHtmlContentType (contentType:string):boolean {
    const type = contentType.split(';', 1)[0]?.trim().toLowerCase()
    return type === 'text/html' ||
        type === 'application/xhtml+xml'
}

async function readBoundedBody (
    response:Response,
    maxBytes:number
):Promise<{ ok:true, text:string } | { ok:false, reason:'too_large' | 'no_body' }> {
    if (!response.body) return { ok: false, reason: 'no_body' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let total = 0
    let text = ''

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue

            total += value.byteLength
            if (total > maxBytes) {
                await reader.cancel()
                return { ok: false, reason: 'too_large' }
            }

            text += decoder.decode(value, { stream: true })
        }
    } finally {
        reader.releaseLock()
    }

    return { ok: true, text: text + decoder.decode() }
}

function nowSqlite ():string {
    return new Date()
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
        .split('.')[0]
}

function classifyFetchError (
    err:unknown
):Exclude<FullContentStatus, 'succeeded' | 'failed_non_html' | 'failed_too_large' | 'failed_no_body'> {
    if (err instanceof FeedFetchError) {
        if (err.status === 310) return 'failed_redirect'
        if (err.status >= 400 && err.status < 600) {
            // Non-2xx publisher response or our own 502 wrappers.
            // 502 here is a wrapper around publisher-side weirdness;
            // we still treat it as a status failure.
            if (err.status === 400 || err.status === 502) {
                if (/host is not allowed|invalid|http or https/i.test(
                    err.message
                )) {
                    return 'failed_network'
                }
            }
            return 'failed_status'
        }
        return 'failed_network'
    }
    return 'failed_network'
}

export async function fetchFullArticle (
    link:string,
    options:Pick<FetchFeedTextOptions, 'fetchFn' | 'resolveHostname'> = {}
):Promise<FetchFullArticleResult> {
    let url:string
    let response:Response

    try {
        const result = await fetchValidatedResponse(link, {
            fetchFn: options.fetchFn,
            resolveHostname: options.resolveHostname,
            maxRedirects: MAX_ARTICLE_REDIRECTS,
            redirectErrorMessage: 'Article redirected too many times',
            signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS)
        })
        url = result.url
        response = result.response
    } catch (err) {
        return { status: classifyFetchError(err) }
    }

    const contentType = response.headers.get('content-type') || ''
    if (!isHtmlContentType(contentType)) {
        try { response.body?.cancel() } catch {}
        return { status: 'failed_non_html' }
    }

    const read = await readBoundedBody(response, MAX_ARTICLE_FETCH_BYTES)
    if (!read.ok) {
        if (read.reason === 'too_large') return { status: 'failed_too_large' }
        return { status: 'failed_no_body' }
    }

    const extracted = extractArticleBody(read.text, url)
    if ('error' in extracted) {
        if (extracted.error === 'too_large') {
            return { status: 'failed_too_large' }
        }
        return { status: 'failed_no_body' }
    }

    return {
        status: 'succeeded',
        html: extracted.html,
        fetchedAt: nowSqlite()
    }
}
