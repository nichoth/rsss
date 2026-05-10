const MAX_FEED_BYTES = 5 * 1024 * 1024
const MAX_HEAD_BYTES = 256 * 1024
const FEED_FETCH_TIMEOUT_MS = 15_000
const MAX_FEED_REDIRECTS = 3
export const MAX_ARTICLE_REDIRECTS = 5
const DNS_JSON_URL = 'https://cloudflare-dns.com/dns-query'

type ResolveHostname = (hostname:string) => Promise<string[]>

export class FeedFetchError extends Error {
    status:number

    constructor (message:string, status = 400) {
        super(message)
        this.name = 'FeedFetchError'
        this.status = status
    }
}

export interface FetchFeedValidators {
    etag?:string
    lastModified?:string
}

export interface FetchFeedTextOptions {
    fetchFn?:typeof fetch
    maxBytes?:number
    resolveHostname?:ResolveHostname
    signal?:AbortSignal
    validators?:FetchFeedValidators
}

export interface FetchOgImageOptions {
    fetchFn?:typeof fetch
    maxBytes?:number
    resolveHostname?:ResolveHostname
    signal?:AbortSignal
    onError?:(err:unknown) => void
}

// Public — used at user-entry / dedup time. Strips trailing slash so
// `…/feed` and `…/feed/` collapse to the same canonical row.
export async function validateFeedUrl (feedUrl:string):Promise<string> {
    const url = parseAndAssertAllowed(feedUrl)

    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
        url.pathname = url.pathname.replace(/\/+$/, '')
    }

    return url.toString()
}

// Security check only. Used inside the redirect loop so we honor whatever
// the server says is canonical — re-applying slash-stripping there causes
// an infinite redirect loop on hosts whose canonical path ends in `/`.
async function assertFeedUrlAllowed (feedUrl:string):Promise<string> {
    return parseAndAssertAllowed(feedUrl).toString()
}

function parseAndAssertAllowed (feedUrl:string):URL {
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

    return url
}

export interface FetchFeedTextResult {
    text:string
    url:string
    notModified:boolean
    etag?:string
    lastModified?:string
}

export async function fetchFeedText (
    feedUrl:string,
    options:FetchFeedTextOptions = {}
):Promise<FetchFeedTextResult> {
    const result = await fetchValidatedResponse(feedUrl, {
        ...options,
        maxRedirects: MAX_FEED_REDIRECTS,
        redirectErrorMessage: 'Feed redirected too many times'
    })

    if (result.notModified) {
        return {
            text: '',
            url: result.url,
            notModified: true,
            etag: undefined,
            lastModified: undefined
        }
    }

    const text = await readBoundedText(
        result.response,
        options.maxBytes || MAX_FEED_BYTES
    )

    const etag = result.response.headers.get('etag') || undefined
    const lastModified = result.response.headers.get('last-modified') ||
        undefined

    return {
        text,
        url: result.url,
        notModified: false,
        etag,
        lastModified
    }
}

export async function fetchOgImage (
    articleUrl:string,
    options:FetchOgImageOptions = {}
):Promise<string|null> {
    try {
        const result = await fetchValidatedResponse(articleUrl, {
            ...options,
            maxRedirects: MAX_ARTICLE_REDIRECTS,
            redirectErrorMessage: 'Article redirected too many times'
        })
        const contentType = result.response.headers.get('content-type') || ''

        if (!isHtmlContentType(contentType)) return null

        const head = await readHeadText(
            result.response,
            options.maxBytes || MAX_HEAD_BYTES
        )
        const candidate = findMetaImage(head)
        if (!candidate) return null

        const imageUrl = new URL(candidate, result.url)
        if (imageUrl.protocol !== 'https:') return null

        return imageUrl.toString()
    } catch (err) {
        options.onError?.(err)
        return null
    }
}

export async function fetchValidatedResponse (
    inputUrl:string,
    options:FetchFeedTextOptions & {
        maxRedirects?:number
        redirectErrorMessage?:string
    }
):Promise<{ response:Response; url:string; notModified:boolean }> {
    let url = await assertFeedUrlAllowed(inputUrl)
    const fetchFn = options.fetchFn || fetch
    const resolveHostname = options.resolveHostname ||
        (options.fetchFn ? undefined : resolveHostnameWithDoh)
    const maxRedirects = options.maxRedirects ?? MAX_FEED_REDIRECTS
    const redirectErrorMessage = options.redirectErrorMessage ||
        'Feed redirected too many times'

    for (let redirectCount = 0; ; redirectCount++) {
        await validateResolvedHostname(url, resolveHostname)

        const headers:Record<string, string> = {
            'User-Agent': 'RSSS/1.0 RSS Reader'
        }
        if (options.validators?.etag) {
            headers['If-None-Match'] = options.validators.etag
        }
        if (options.validators?.lastModified) {
            headers['If-Modified-Since'] = options.validators.lastModified
        }

        const response = await fetchFn(url, {
            headers,
            redirect: 'manual',
            signal: options.signal ||
                AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS)
        })

        if (response.status === 304) {
            return { response, url, notModified: true }
        }

        if (isRedirect(response)) {
            if (redirectCount >= maxRedirects) {
                throw new FeedFetchError(
                    redirectErrorMessage,
                    310
                )
            }

            const location = response.headers.get('location')
            if (!location) {
                throw new FeedFetchError(
                    'Feed redirect is missing a location header',
                    502
                )
            }

            url = await assertFeedUrlAllowed(
                new URL(location, url).toString()
            )
            continue
        }

        if (!response.ok) {
            throw new FeedFetchError(
                `Feed fetch failed with status ${response.status}`,
                response.status
            )
        }

        return { response, url, notModified: false }
    }
}

function isBlockedHostname (hostname:string):boolean {
    const normalized = hostname
        .toLowerCase()
        .replace(/^\[(.*)\]$/, '$1')

    return normalized === 'localhost' ||
        normalized.endsWith('.local') ||
        isBlockedIpLiteral(normalized)
}

function isBlockedIpLiteral (hostname:string):boolean {
    const ipv4 = parseIpv4(hostname)
    if (ipv4) return isBlockedIpv4(ipv4)

    const ipv6 = parseIpv6(hostname)
    if (ipv6) return isBlockedIpv6(ipv6)

    return false
}

function isIpLiteral (hostname:string):boolean {
    return Boolean(parseIpv4(hostname) || parseIpv6(hostname))
}

function parseIpv4 (hostname:string):number[]|null {
    const parts = hostname.split('.')
    if (parts.length !== 4) return null

    const bytes:number[] = []

    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null

        const value = Number(part)
        if (!Number.isInteger(value) || value < 0 || value > 255) {
            return null
        }

        bytes.push(value)
    }

    return bytes
}

function parseIpv6 (hostname:string):number[]|null {
    if (!hostname.includes(':')) return null

    let candidate = hostname

    if (candidate.includes('.')) {
        const lastColon = candidate.lastIndexOf(':')
        const ipv4 = parseIpv4(candidate.slice(lastColon + 1))
        if (!ipv4) return null

        const high = (ipv4[0] << 8) + ipv4[1]
        const low = (ipv4[2] << 8) + ipv4[3]
        candidate = candidate.slice(0, lastColon) +
            `:${high.toString(16)}:${low.toString(16)}`
    }

    const compressed = candidate.split('::')
    if (compressed.length > 2) return null

    const left = parseIpv6Side(compressed[0])
    const right = compressed.length === 2 ?
        parseIpv6Side(compressed[1]) :
        []

    if (!left || !right) return null

    const missing = 8 - left.length - right.length
    if (compressed.length === 1 && missing !== 0) return null
    if (compressed.length === 2 && missing < 1) return null

    return [
        ...left,
        ...Array(missing).fill(0),
        ...right
    ]
}

function parseIpv6Side (side:string):number[]|null {
    if (!side) return []

    const values:number[] = []

    for (const part of side.split(':')) {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null

        const value = Number.parseInt(part, 16)
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
            return null
        }

        values.push(value)
    }

    return values
}

function isBlockedIpv4 (bytes:number[]):boolean {
    const [a, b] = bytes

    return a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
}

function isBlockedIpv6 (hextets:number[]):boolean {
    const isUnspecified = hextets.every(value => value === 0)
    const isLoopback = hextets.slice(0, 7).every(value => value === 0) &&
        hextets[7] === 1
    const isUniqueLocal = (hextets[0] & 0xfe00) === 0xfc00
    const isLinkLocal = (hextets[0] & 0xffc0) === 0xfe80
    const isMappedIpv4 = hextets.slice(0, 5).every(value => value === 0) &&
        hextets[5] === 0xffff

    if (isMappedIpv4) {
        const ipv4 = [
            hextets[6] >> 8,
            hextets[6] & 0xff,
            hextets[7] >> 8,
            hextets[7] & 0xff
        ]

        return isBlockedIpv4(ipv4)
    }

    return isUnspecified ||
        isLoopback ||
        isUniqueLocal ||
        isLinkLocal
}

async function validateResolvedHostname (
    feedUrl:string,
    resolveHostname?:ResolveHostname
):Promise<void> {
    if (!resolveHostname) return

    const { hostname } = new URL(feedUrl)
    const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')

    if (isBlockedIpLiteral(normalized)) {
        throw new FeedFetchError('Feed URL host is not allowed')
    }

    if (isIpLiteral(normalized)) return

    const resolved = await resolveHostname(hostname)

    if (resolved.some(address => isBlockedHostname(address))) {
        throw new FeedFetchError('Feed URL host is not allowed')
    }
}

async function resolveHostnameWithDoh (hostname:string):Promise<string[]> {
    const records = await Promise.all([
        resolveDnsJson(hostname, 'A'),
        resolveDnsJson(hostname, 'AAAA')
    ])

    return records.flat()
}

async function resolveDnsJson (
    hostname:string,
    type:'A'|'AAAA'
):Promise<string[]> {
    const url = new URL(DNS_JSON_URL)
    url.searchParams.set('name', hostname)
    url.searchParams.set('type', type)

    const response = await fetch(url, {
        headers: {
            accept: 'application/dns-json'
        },
        signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS)
    })

    if (!response.ok) {
        throw new FeedFetchError(
            `DNS resolution failed with status ${response.status}`,
            502
        )
    }

    const body = await response.json() as {
        Answer?:Array<{ data?:unknown }>
    }

    return (body.Answer || [])
        .map(answer => answer.data)
        .filter((data):data is string => typeof data === 'string')
        .filter(data => parseIpv4(data) || parseIpv6(data))
}

function isRedirect (response:Response):boolean {
    return response.status >= 300 && response.status < 400
}

async function readBoundedText (
    response:Response,
    maxBytes:number
):Promise<string> {
    if (!response.body) {
        throw new FeedFetchError(
            'Feed response has no readable body',
            502
        )
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

async function readHeadText (
    response:Response,
    maxBytes:number
):Promise<string> {
    if (!response.body) {
        throw new FeedFetchError(
            'Feed response has no readable body',
            502
        )
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
                break
            }

            text += decoder.decode(value, { stream: true })
            const headEnd = text.search(/<\/head\s*>/i)
            if (headEnd !== -1) {
                await reader.cancel()
                text = text.slice(0, headEnd)
                break
            }
        }
    } finally {
        reader.releaseLock()
    }

    return text + decoder.decode()
}

function isHtmlContentType (contentType:string):boolean {
    const type = contentType.split(';', 1)[0]?.trim().toLowerCase()

    return type === 'text/html' ||
        type === 'application/xhtml+xml'
}

function findMetaImage (html:string):string|null {
    const keys = [
        { attr: 'property', value: 'og:image' },
        { attr: 'name', value: 'og:image' },
        { attr: 'property', value: 'og:image:secure_url' },
        { attr: 'property', value: 'og:image:url' },
        { attr: 'name', value: 'twitter:image' }
    ]

    for (const key of keys) {
        const value = findMetaContent(html, key.attr, key.value)
        if (value) return value
    }

    return null
}

function findMetaContent (
    html:string,
    keyAttr:string,
    keyValue:string
):string|null {
    const metaTags = html.match(/<meta\b[^>]*>/gi) || []

    for (const tag of metaTags) {
        const attrs = readTagAttributes(tag)
        if (attrs.get(keyAttr)?.toLowerCase() !== keyValue) continue

        const content = attrs.get('content')?.trim()
        if (content) return content
    }

    return null
}

function readTagAttributes (tag:string):Map<string, string> {
    const attrs = new Map<string, string>()
    const attrPattern = /([^\s"'=<>`]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g
    let match:RegExpExecArray|null

    while ((match = attrPattern.exec(tag))) {
        const name = match[1]?.toLowerCase()
        const rawValue = match[2]
        if (!name || !rawValue) continue

        attrs.set(name, rawValue.replace(/^['"]|['"]$/g, ''))
    }

    return attrs
}
