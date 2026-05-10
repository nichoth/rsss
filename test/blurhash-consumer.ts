import { test } from '@substrate-system/tapzero'
import {
    BLURHASH_CACHE_TTL_SECONDS,
    fetchBlurhashImageBytes,
    handleBlurhashQueueBatch,
    type BlurhashConsumerDeps,
    type BlurhashConsumerEnv,
    type BlurhashJob
} from '../src/server/blurhash-consumer.js'

interface FakeMessage {
    body:BlurhashJob
    acked:boolean
    ack:() => void
    retry:() => void
}

interface FakeImage {
    width:number
    height:number
    pixels:Uint8ClampedArray
    freed:boolean
    get_width:() => number
    get_height:() => number
    get_raw_pixels:() => Uint8Array | Uint8ClampedArray
    free:() => void
}

function fakeImage (
    width:number,
    height:number,
    pixels = new Uint8ClampedArray(width * height * 4)
):FakeImage {
    const image = {
        width,
        height,
        pixels,
        freed: false,
        get_width () {
            return width
        },
        get_height () {
            return height
        },
        get_raw_pixels () {
            return pixels
        },
        free () {
            image.freed = true
        }
    }

    return image
}

function fakeMessage (body:BlurhashJob):FakeMessage {
    return {
        body,
        acked: false,
        ack () {
            this.acked = true
        },
        retry () {
            throw new Error('unexpected retry')
        }
    }
}

function fakeBatch (messages:FakeMessage[]) {
    return {
        queue: 'blurhash-jobs',
        messages,
        ackAll () {},
        retryAll () {}
    }
}

function blurhashEntry ():string {
    return JSON.stringify({
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        image_width: 1200,
        image_height: 630
    })
}

function fakeUserDoEnv (requests:Request[]):BlurhashConsumerEnv {
    return {
        BLURHASH_KV: {
            async get () {
                return null
            },
            async put () {}
        },
        USER_DO: {
            idFromString (id:string) {
                return id as unknown as DurableObjectId
            },
            get () {
                return {
                    async fetch (request:Request) {
                        requests.push(request)
                        return new Response(null, { status: 204 })
                    }
                }
            }
        }
    }
}

test('blurhash consumer writes cached metadata without fetching', async t => {
    const requests:Request[] = []
    const message = fakeMessage({
        imageUrl: 'https://cdn.example.com/cached.jpg',
        itemId: 42,
        objectId: 'user-do-id'
    })
    let kvReads = 0
    const env = fakeUserDoEnv(requests)

    env.BLURHASH_KV.get = async () => {
        kvReads++
        return blurhashEntry()
    }
    const deps:BlurhashConsumerDeps = {
        async fetchImage () {
            throw new Error('cache hit must not fetch')
        },
        decodeImage () {
            throw new Error('cache hit must not decode')
        },
        resizeImage () {
            throw new Error('cache hit must not resize')
        },
        encodePixels () {
            throw new Error('cache hit must not encode')
        }
    }

    await handleBlurhashQueueBatch(fakeBatch([message]), env, deps)

    t.equal(kvReads, 1, 'KV is re-checked before encoding')
    t.equal(requests.length, 1, 'cached metadata is written to the DO')
    t.equal(new URL(requests[0].url).pathname, '/internal/blurhash/items/42')
    t.equal(requests[0].method, 'POST', 'DO update uses POST')
    t.deepEqual(await requests[0].json(), {
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        image_width: 1200,
        image_height: 630
    })
    t.equal(message.acked, true, 'successful cache hit is acked')
})

test('blurhash consumer encodes image on cache miss', async t => {
    const requests:Request[] = []
    const message = fakeMessage({
        imageUrl: 'https://cdn.example.com/miss.jpg',
        itemId: 43,
        objectId: 'user-do-id'
    })
    const originalImage = fakeImage(640, 480)
    const resizedPixels = new Uint8ClampedArray(32 * 32 * 4)
    const resizedImage = fakeImage(32, 32, resizedPixels)
    const kvWrites:Array<{
        key:string
        value:string
        ttl:number|undefined
    }> = []
    let fetchRequest:Request|null = null
    let fetchUserAgent:string|null = null
    let encodeArgs:null | {
        pixels:Uint8ClampedArray
        width:number
        height:number
        componentX:number
        componentY:number
    } = null
    const env = fakeUserDoEnv(requests)

    env.BLURHASH_KV.put = async (key, value, options) => {
        kvWrites.push({
            key,
            value,
            ttl: options?.expirationTtl
        })
    }
    const deps:BlurhashConsumerDeps = {
        async fetchImage (request, userAgent) {
            fetchRequest = request
            fetchUserAgent = userAgent
            return new Uint8Array([1, 2, 3])
        },
        decodeImage (bytes) {
            t.deepEqual([...bytes], [1, 2, 3], 'fetched bytes are decoded')
            return originalImage
        },
        resizeImage (image, width, height) {
            t.equal(image, originalImage, 'original image is resized')
            t.equal(width, 32, 'resize width is 32')
            t.equal(height, 32, 'resize height is 32')
            return resizedImage
        },
        encodePixels (pixels, width, height, componentX, componentY) {
            encodeArgs = {
                pixels,
                width,
                height,
                componentX,
                componentY
            }
            return 'LEHV6nWB2yk8pyo0adR*.7kCMdnj'
        }
    }

    await handleBlurhashQueueBatch(fakeBatch([message]), env, deps)

    const request = fetchRequest as Request|null
    const userAgent = fetchUserAgent as string|null

    t.ok(request, 'image is fetched')
    t.equal(request?.url, 'https://cdn.example.com/miss.jpg')
    t.ok(userAgent?.includes('Mozilla'), 'fetch uses browser UA')
    t.ok(request?.signal instanceof AbortSignal, 'fetch gets a signal')
    t.deepEqual(encodeArgs, {
        pixels: resizedPixels,
        width: 32,
        height: 32,
        componentX: 4,
        componentY: 4
    }, 'resized RGBA pixels are encoded with 4x4 components')
    t.equal(originalImage.freed, true, 'original image is freed')
    t.equal(resizedImage.freed, true, 'resized image is freed')
    t.equal(kvWrites.length, 1, 'encoded metadata is written to KV')
    t.equal(kvWrites[0].ttl, BLURHASH_CACHE_TTL_SECONDS)
    t.equal(requests.length, 1, 'encoded metadata is written to the DO')
    t.deepEqual(await requests[0].json(), {
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        image_width: 640,
        image_height: 480
    })
    t.equal(message.acked, true, 'successful encode is acked')
})

test('blurhash consumer acks permanent decode failures', async t => {
    const requests:Request[] = []
    const message = fakeMessage({
        imageUrl: 'https://cdn.example.com/corrupt.jpg',
        itemId: 44,
        objectId: 'user-do-id'
    })
    const env = fakeUserDoEnv(requests)
    let kvWrites = 0

    env.BLURHASH_KV.put = async () => {
        kvWrites++
    }
    const deps:BlurhashConsumerDeps = {
        async fetchImage () {
            return new Uint8Array([1, 2, 3])
        },
        decodeImage () {
            throw new Error('unsupported image')
        },
        resizeImage () {
            throw new Error('permanent decode failure must not resize')
        },
        encodePixels () {
            throw new Error('permanent decode failure must not encode')
        }
    }

    await handleBlurhashQueueBatch(fakeBatch([message]), env, deps)

    t.equal(message.acked, true, 'permanent decode failure is acked')
    t.equal(requests.length, 0, 'permanent decode failure skips DO write')
    t.equal(kvWrites, 0, 'permanent decode failure skips KV write')
})

test('blurhash consumer retries transient failures', async t => {
    const cases:Array<{
        name:string
        configure:(env:BlurhashConsumerEnv) => BlurhashConsumerDeps
    }> = [
        {
            name: '5xx fetch',
            configure () {
                return {
                    async fetchImage () {
                        throw new Error('BlurHash image fetch failed: 503')
                    },
                    decodeImage () {
                        throw new Error('5xx fetch must not decode')
                    },
                    resizeImage () {
                        throw new Error('5xx fetch must not resize')
                    },
                    encodePixels () {
                        throw new Error('5xx fetch must not encode')
                    }
                }
            }
        },
        {
            name: 'fetch timeout',
            configure () {
                return {
                    async fetchImage () {
                        throw new DOMException('timed out', 'AbortError')
                    },
                    decodeImage () {
                        throw new Error('timeout must not decode')
                    },
                    resizeImage () {
                        throw new Error('timeout must not resize')
                    },
                    encodePixels () {
                        throw new Error('timeout must not encode')
                    }
                }
            }
        },
        {
            name: 'KV write failure',
            configure (env) {
                const deps = successfulEncodeDeps()

                env.BLURHASH_KV.put = async () => {
                    throw new Error('kv unavailable')
                }

                return deps
            }
        },
        {
            name: 'D1 write failure',
            configure () {
                return successfulEncodeDeps()
            }
        },
        {
            name: 'Photon crash mid-encode',
            configure () {
                const deps = successfulEncodeDeps()

                deps.encodePixels = () => {
                    throw new Error('wasm crashed')
                }

                return deps
            }
        }
    ]

    for (const testCase of cases) {
        const requests:Request[] = []
        const message = fakeMessage({
            imageUrl: `https://cdn.example.com/${testCase.name}.jpg`,
            itemId: 45,
            objectId: 'user-do-id'
        })
        const env = fakeUserDoEnv(requests)

        if (testCase.name === 'D1 write failure') {
            env.USER_DO.get = () => ({
                async fetch (request:Request) {
                    requests.push(request)
                    return new Response(null, { status: 500 })
                }
            })
        }

        try {
            await handleBlurhashQueueBatch(
                fakeBatch([message]),
                env,
                testCase.configure(env)
            )
            t.fail(`${testCase.name} should throw for queue retry`)
        } catch (err) {
            t.ok(err instanceof Error, `${testCase.name} throws`)
        }

        t.equal(message.acked, false, `${testCase.name} is not acked`)
    }
})

test('fetchBlurhashImageBytes skips content-length over 5 MB', async t => {
    let bodyRead = false

    const bytes = await fetchBlurhashImageBytes(
        new Request('https://cdn.example.com/huge.jpg'),
        async () => ({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-length': String(5 * 1024 * 1024 + 1)
            }),
            async arrayBuffer () {
                bodyRead = true
                return new ArrayBuffer(0)
            }
        } as Response)
    )

    t.equal(bytes, null, 'oversized content-length is skipped')
    t.equal(bodyRead, false, 'oversized body is not read')
})

test('fetchBlurhashImageBytes skips image fetch 4xx responses', async t => {
    let bodyRead = false

    const bytes = await fetchBlurhashImageBytes(
        new Request('https://cdn.example.com/missing.jpg'),
        async () => ({
            ok: false,
            status: 404,
            headers: new Headers(),
            async arrayBuffer () {
                bodyRead = true
                return new ArrayBuffer(0)
            }
        } as Response)
    )

    t.equal(bytes, null, '4xx image fetch is permanently skipped')
    t.equal(bodyRead, false, '4xx body is not read')
})

test('fetchBlurhashImageBytes retries image fetch 5xx responses', async t => {
    try {
        await fetchBlurhashImageBytes(
            new Request('https://cdn.example.com/error.jpg'),
            async () => new Response(null, { status: 503 })
        )
        t.fail('5xx image fetch should throw for retry')
    } catch (err) {
        t.ok(err instanceof Error, '5xx image fetch throws')
    }
})

test('fetchBlurhashImageBytes skips actual bytes over 5 MB', async t => {
    const bytes = await fetchBlurhashImageBytes(
        new Request('https://cdn.example.com/huge.jpg'),
        async () => new Response(
            new Uint8Array(5 * 1024 * 1024 + 1),
            { status: 200 }
        )
    )

    t.equal(bytes, null, 'oversized response body is skipped')
})

function successfulEncodeDeps ():BlurhashConsumerDeps {
    const originalImage = fakeImage(640, 480)
    const resizedImage = fakeImage(32, 32)

    return {
        async fetchImage () {
            return new Uint8Array([1, 2, 3])
        },
        decodeImage () {
            return originalImage
        },
        resizeImage () {
            return resizedImage
        },
        encodePixels () {
            return 'LEHV6nWB2yk8pyo0adR*.7kCMdnj'
        }
    }
}
