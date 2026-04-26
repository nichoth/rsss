const MAX_FEED_BYTES = 5 * 1024 * 1024
const FEED_FETCH_TIMEOUT_MS = 15_000

export class FeedFetchError extends Error {
    status:number

    constructor (message:string, status = 400) {
        super(message)
        this.name = 'FeedFetchError'
        this.status = status
    }
}

export interface FetchFeedTextOptions {
    fetchFn?:typeof fetch
    maxBytes?:number
}

export async function validateFeedUrl (feedUrl:string):Promise<string> {
    let url:URL

    try {
        url = new URL(feedUrl)
    } catch {
        throw new FeedFetchError('Feed URL is invalid')
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new FeedFetchError('Feed URL must use http or https')
    }

    if (isBlockedHostname(url.hostname)) {
        throw new FeedFetchError('Feed URL host is not allowed')
    }

    return url.toString()
}

export async function fetchFeedText (
    feedUrl:string,
    options:FetchFeedTextOptions = {}
):Promise<string> {
    const url = await validateFeedUrl(feedUrl)
    const fetchFn = options.fetchFn || fetch
    const maxBytes = options.maxBytes || MAX_FEED_BYTES
    const response = await fetchFn(url, {
        headers: {
            'User-Agent': 'RSSS/1.0 RSS Reader'
        },
        signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS)
    })

    if (!response.ok) {
        throw new FeedFetchError(
            `Feed fetch failed with status ${response.status}`,
            response.status
        )
    }

    return readBoundedText(response, maxBytes)
}

function isBlockedHostname (hostname:string):boolean {
    const normalized = hostname
        .toLowerCase()
        .replace(/^\[(.*)\]$/, '$1')

    return normalized === 'localhost' ||
        normalized === '0.0.0.0' ||
        normalized === '::1' ||
        normalized.endsWith('.local') ||
        normalized.startsWith('127.')
}

async function readBoundedText (
    response:Response,
    maxBytes:number
):Promise<string> {
    if (!response.body) {
        const text = await response.text()
        const size = new TextEncoder().encode(text).byteLength
        if (size > maxBytes) {
            throw new FeedFetchError(
                `Feed response exceeds ${maxBytes} bytes`,
                413
            )
        }
        return text
    }

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
                throw new FeedFetchError(
                    `Feed response exceeds ${maxBytes} bytes`,
                    413
                )
            }

            text += decoder.decode(value, { stream: true })
        }
    } finally {
        reader.releaseLock()
    }

    return text + decoder.decode()
}
