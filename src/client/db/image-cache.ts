import type { Sqlite3Db } from './sqlite-init.js'
import { queryDb } from './local-db.js'
import { recordCachedImage } from './cached-images.js'
import {
    defaultCacheMode,
    type CacheMode
} from '../local-first-settings.js'

export interface FeedCachePolicyRow {
    cache_mode:CacheMode|null
}

function extractImageUrls (html:string|null|undefined):string[] {
    if (!html) return []
    const urls:string[] = []
    const re = /<img\s[^>]*?src="([^"]+)"/gi
    let m:RegExpExecArray|null
    while ((m = re.exec(html)) !== null) {
        if (!/^https?:\/\//i.test(m[1])) continue
        urls.push(m[1])
    }
    return urls
}

export async function cacheItemImages (
    db:Sqlite3Db,
    item:{
        id?:number|null
        feed_id:number
        content?:string|null
        description?:string|null
    },
    policy:FeedCachePolicyRow|null,
    fetchFn:typeof fetch = fetch,
    cacheStorage:Pick<CacheStorage, 'open'> = caches
):Promise<void> {
    const effectiveMode = policy?.cache_mode ?? defaultCacheMode.value
    if (effectiveMode === 'text') return

    const urls = [
        ...extractImageUrls(item.content),
        ...extractImageUrls(item.description)
    ]
    const uniqueUrls = [...new Set(urls)]
    if (uniqueUrls.length === 0) return

    const existing = await queryDb<{ url:string }>(
        db,
        `SELECT url FROM cached_images WHERE url IN (${
            uniqueUrls.map(() => '?').join(',')
        })`,
        uniqueUrls
    )
    const alreadyCached = new Set(existing.map((r) => r.url))

    const bucket = await cacheStorage.open('rsss-images-v1')

    for (const url of uniqueUrls) {
        if (alreadyCached.has(url)) continue
        try {
            const res = await fetchFn(url)
            const buf = await res.arrayBuffer()
            await bucket.put(url, new Response(buf, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers
            }))
            await recordCachedImage(db, {
                url,
                feedId: item.feed_id,
                itemId: item.id ?? null,
                sizeBytes: buf.byteLength
            })
        } catch (err) {
            console.error(
                '[image-cache] failed to cache image',
                err instanceof Error ? err.message : ''
            )
        }
    }
}
