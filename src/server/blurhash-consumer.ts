import {
    blurhashCacheKey,
    parseBlurhashCacheEntry,
    type BlurhashCacheEntry,
    type BlurhashJob
} from './blurhash.js'

export type { BlurhashJob }

export interface BlurhashImage {
    get_width:() => number
    get_height:() => number
    get_raw_pixels:() => Uint8Array | Uint8ClampedArray
    free:() => void
}

export interface BlurhashConsumerDeps {
    fetchImage:(request:Request, userAgent:string) => Promise<Uint8Array|null>
    decodeImage:(bytes:Uint8Array) => BlurhashImage
    resizeImage:(
        image:BlurhashImage,
        width:number,
        height:number
    ) => BlurhashImage
    encodePixels:(
        pixels:Uint8ClampedArray,
        width:number,
        height:number,
        componentX:number,
        componentY:number
    ) => string
}

export interface BlurhashConsumerEnv {
    BLURHASH_KV:{
        get:(key:string) => Promise<string|null>
        put:(
            key:string,
            value:string,
            options?:{ expirationTtl?:number }
        ) => Promise<void>
    }
    USER_DO:{
        idFromString:(id:string) => DurableObjectId
        get:(id:DurableObjectId) => { fetch:(request:Request) =>
            Promise<Response> }
    }
}

interface QueueMessageLike {
    body:unknown
    ack:() => void
}

interface QueueBatchLike {
    messages:readonly QueueMessageLike[]
}

const IMAGE_FETCH_TIMEOUT_MS = 10_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const BLURHASH_SIZE = 32
const BLURHASH_COMPONENTS = 4
const BROWSER_USER_AGENT = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    'Chrome/120.0.0.0 Safari/537.36'
].join(' ')

export const BLURHASH_CACHE_TTL_SECONDS = 60 * 60 * 24 * 90

function isBlurhashJob (value:unknown):value is BlurhashJob {
    if (!value || typeof value !== 'object') return false

    const job = value as Partial<BlurhashJob>

    return typeof job.imageUrl === 'string' &&
        typeof job.itemId === 'number' &&
        typeof job.objectId === 'string'
}

function blurhashRequest (imageUrl:string):{
    request:Request
    cancel:() => void
} {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
        controller.abort()
    }, IMAGE_FETCH_TIMEOUT_MS)

    return {
        request: new Request(imageUrl, {
            headers: {
                'user-agent': BROWSER_USER_AGENT
            },
            signal: controller.signal
        }),
        cancel () {
            clearTimeout(timeout)
        }
    }
}

async function writeItemBlurhash (
    env:BlurhashConsumerEnv,
    job:BlurhashJob,
    entry:BlurhashCacheEntry
):Promise<void> {
    const id = env.USER_DO.idFromString(job.objectId)
    const stub = env.USER_DO.get(id)
    const response = await stub.fetch(new Request(
        `http://do/internal/blurhash/items/${job.itemId}`,
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify(entry)
        }
    ))

    if (!response.ok) {
        throw new Error(`BlurHash item update failed: ${response.status}`)
    }
}

function toClampedPixels (
    pixels:Uint8Array | Uint8ClampedArray
):Uint8ClampedArray {
    if (pixels instanceof Uint8ClampedArray) return pixels
    return new Uint8ClampedArray(
        pixels.buffer,
        pixels.byteOffset,
        pixels.byteLength
    )
}

async function encodeBlurhashEntry (
    job:BlurhashJob,
    deps:BlurhashConsumerDeps
):Promise<BlurhashCacheEntry | null> {
    const { request, cancel } = blurhashRequest(job.imageUrl)
    let original:BlurhashImage|null = null
    let resized:BlurhashImage|null = null

    try {
        const bytes = await deps.fetchImage(request, BROWSER_USER_AGENT)
        if (!bytes) return null

        try {
            original = deps.decodeImage(bytes)
        } catch (_err) {
            return null
        }

        const imageWidth = original.get_width()
        const imageHeight = original.get_height()

        resized = deps.resizeImage(
            original,
            BLURHASH_SIZE,
            BLURHASH_SIZE
        )

        const blurhash = deps.encodePixels(
            toClampedPixels(resized.get_raw_pixels()),
            BLURHASH_SIZE,
            BLURHASH_SIZE,
            BLURHASH_COMPONENTS,
            BLURHASH_COMPONENTS
        )

        return {
            blurhash,
            image_width: imageWidth,
            image_height: imageHeight
        }
    } finally {
        cancel()
        resized?.free()
        original?.free()
    }
}

async function handleBlurhashMessage (
    message:QueueMessageLike,
    env:BlurhashConsumerEnv,
    deps:BlurhashConsumerDeps
):Promise<void> {
    if (!isBlurhashJob(message.body)) {
        message.ack()
        return
    }

    const job = message.body
    const key = await blurhashCacheKey(job.imageUrl)
    const cached = parseBlurhashCacheEntry(await env.BLURHASH_KV.get(key))

    if (cached) {
        await writeItemBlurhash(env, job, cached)
        message.ack()
        return
    }

    const entry = await encodeBlurhashEntry(job, deps)
    if (!entry) {
        message.ack()
        return
    }

    await env.BLURHASH_KV.put(key, JSON.stringify(entry), {
        expirationTtl: BLURHASH_CACHE_TTL_SECONDS
    })
    await writeItemBlurhash(env, job, entry)
    message.ack()
}

export async function handleBlurhashQueueBatch (
    batch:QueueBatchLike,
    env:BlurhashConsumerEnv,
    deps:BlurhashConsumerDeps
):Promise<void> {
    for (const message of batch.messages) {
        await handleBlurhashMessage(message, env, deps)
    }
}

export async function fetchBlurhashImageBytes (
    request:Request,
    fetcher:typeof fetch = fetch
):Promise<Uint8Array|null> {
    const response = await fetcher(request)
    const contentLength = Number(response.headers.get('content-length') ?? 0)

    if (response.status >= 400 && response.status < 500) return null

    if (!response.ok) {
        throw new Error(`BlurHash image fetch failed: ${response.status}`)
    }
    if (contentLength > MAX_IMAGE_BYTES) return null

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) return null

    return bytes
}
