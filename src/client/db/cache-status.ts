import type { Sqlite3Db } from './sqlite-init.js'
import { queryDb } from './local-db.js'
import {
    feedPolicies,
    resolveEffectivePolicy
} from './feed-cache-policy.js'
import { storeContent } from '../local-first-settings.js'

export interface ItemToCache {
    id:number
    feed_id:number
    content:string|null
    description:string|null
    full_content:string|null
    missingBody:boolean
    missingImageUrls:string[]
}

export interface CacheStatusSnapshot {
    uncachedCount:number
    totalCount:number
    itemsToCache:ItemToCache[]
}

interface ItemRow {
    id:number
    feed_id:number
    content:string|null
    description:string|null
    full_content:string|null
}

const URL_CHUNK = 500

function extractImageUrls (html:string|null|undefined):string[] {
    if (!html) return []
    const urls:string[] = []
    const re = /<img\s[^>]*?src="([^"]+)"/gi
    let m:RegExpExecArray|null
    while ((m = re.exec(html)) !== null) {
        if (!/^https?:\/\//i.test(m[1])) continue
        urls.push(m[1])
    }
    return [...new Set(urls)]
}

export async function computeCacheStatus (
    db:Sqlite3Db,
    scope:{ feedId:number|null }
):Promise<CacheStatusSnapshot> {
    const rows = scope.feedId === null ?
        await queryDb<ItemRow>(
            db,
            'SELECT id, feed_id, content, description, full_content' +
                ' FROM items'
        ) :
        await queryDb<ItemRow>(
            db,
            'SELECT id, feed_id, content, description, full_content' +
                ' FROM items WHERE feed_id = ?',
            [scope.feedId]
        )

    const totalCount = rows.length
    if (totalCount === 0) {
        return { uncachedCount: 0, totalCount: 0, itemsToCache: [] }
    }

    const policiesByFeed = feedPolicies.value
    const wantBody = storeContent.value

    const allUrls = new Set<string>()
    const urlsByItemId = new Map<number, string[]>()

    for (const row of rows) {
        const policy = policiesByFeed[row.feed_id] ?? null
        const effective = resolveEffectivePolicy(policy)
        if (effective.cacheMode !== 'text_images') continue
        const urls = [
            ...extractImageUrls(row.content),
            ...extractImageUrls(row.description)
        ]
        const unique = [...new Set(urls)]
        if (unique.length === 0) continue
        urlsByItemId.set(row.id, unique)
        for (const u of unique) allUrls.add(u)
    }

    const cachedSet = new Set<string>()
    if (allUrls.size > 0) {
        const urlList = [...allUrls]
        for (let i = 0; i < urlList.length; i += URL_CHUNK) {
            const chunk = urlList.slice(i, i + URL_CHUNK)
            const placeholders = chunk.map(() => '?').join(',')
            const cachedRows = await queryDb<{ url:string }>(
                db,
                'SELECT url FROM cached_images WHERE url IN (' +
                    placeholders + ')',
                chunk
            )
            for (const r of cachedRows) cachedSet.add(r.url)
        }
    }

    const itemsToCache:ItemToCache[] = []
    let uncachedCount = 0

    for (const row of rows) {
        const policy = policiesByFeed[row.feed_id] ?? null
        const effective = resolveEffectivePolicy(policy)

        const hasBody = Boolean(
            row.content || row.description || row.full_content
        )
        const missingBody = wantBody && !hasBody

        let missingImageUrls:string[] = []
        if (effective.cacheMode === 'text_images') {
            const urls = urlsByItemId.get(row.id) ?? []
            missingImageUrls = urls.filter(u => !cachedSet.has(u))
        }

        if (missingBody || missingImageUrls.length > 0) {
            uncachedCount++
            itemsToCache.push({
                id: row.id,
                feed_id: row.feed_id,
                content: row.content,
                description: row.description,
                full_content: row.full_content,
                missingBody,
                missingImageUrls
            })
        }
    }

    return { uncachedCount, totalCount, itemsToCache }
}
