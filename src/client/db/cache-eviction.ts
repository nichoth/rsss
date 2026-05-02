import type { Sqlite3Db } from './sqlite-init.js'
import { queryDb, queryOneDb, execDb } from './local-db.js'
import {
    getFeedCachePolicy,
    resolveEffectivePolicy
} from './feed-cache-policy.js'
import { getCurrentlyOpenItemId } from '../open-item-registry.js'
import {
    defaultAccountMaxSizeBytes
} from '../local-first-settings.js'

export async function evictByMaxAge (
    db:Sqlite3Db,
    cacheStorage:Pick<CacheStorage, 'open'> = caches
):Promise<{ itemsEvicted:number; imagesEvicted:number }> {
    const feeds = await queryDb<{ id:number }>(
        db,
        'SELECT id FROM feeds'
    )

    let itemsEvicted = 0
    let imagesEvicted = 0
    const openItemId = getCurrentlyOpenItemId()

    for (const feed of feeds) {
        const policy = await getFeedCachePolicy(db, feed.id)
        const { maxAgeSeconds } = resolveEffectivePolicy(policy)

        let sql =
            'SELECT id FROM items' +
            ' WHERE feed_id = ?' +
            ' AND (content IS NOT NULL OR description IS NOT NULL)' +
            " AND (julianday('now') - julianday(updated_at))" +
            ' * 86400 > ?'
        const bind:(number|null)[] = [feed.id, maxAgeSeconds]

        if (openItemId !== null) {
            sql += ' AND id != ?'
            bind.push(openItemId)
        }

        const staleItems = await queryDb<{ id:number }>(db, sql, bind)
        if (staleItems.length === 0) continue

        const ids = staleItems.map(r => r.id)
        const ph = ids.map(() => '?').join(', ')

        const images = await queryDb<{ url:string }>(
            db,
            'SELECT url FROM cached_images' +
                ' WHERE item_id IN (' + ph + ')',
            ids
        )

        await execDb(db, {
            sql: 'UPDATE items SET content = NULL,' +
                ' description = NULL WHERE id IN (' + ph + ')',
            bind: ids
        })

        if (images.length > 0) {
            await execDb(db, {
                sql: 'DELETE FROM cached_images' +
                    ' WHERE item_id IN (' + ph + ')',
                bind: ids
            })
            const bucket = await cacheStorage.open('rsss-images-v1')
            for (const img of images) {
                await bucket.delete(img.url)
                imagesEvicted++
            }
        }

        itemsEvicted += ids.length
    }

    return { itemsEvicted, imagesEvicted }
}

export async function evictByFeedSizeCap (
    db:Sqlite3Db,
    cacheStorage:Pick<CacheStorage, 'open'> = caches
):Promise<{ feedsTrimmed:number; bytesFreed:number }> {
    const feeds = await queryDb<{ id:number }>(db, 'SELECT id FROM feeds')
    const openItemId = getCurrentlyOpenItemId()
    let feedsTrimmed = 0
    let bytesFreed = 0

    for (const feed of feeds) {
        const policy = await getFeedCachePolicy(db, feed.id)
        const { maxSizeBytes } = resolveEffectivePolicy(policy)

        const textRow = await queryOneDb<{ total:number|null }>(
            db,
            'SELECT SUM(COALESCE(LENGTH(content), 0) +' +
            ' COALESCE(LENGTH(description), 0)) AS total' +
            ' FROM items WHERE feed_id = ?',
            [feed.id]
        )
        const imageRow = await queryOneDb<{ total:number|null }>(
            db,
            'SELECT SUM(size_bytes) AS total FROM cached_images' +
            ' WHERE feed_id = ?',
            [feed.id]
        )
        let currentSize = (textRow?.total ?? 0) + (imageRow?.total ?? 0)
        if (currentSize <= maxSizeBytes) continue

        let sql =
            'SELECT id,' +
            ' COALESCE(LENGTH(content), 0) +' +
            '  COALESCE(LENGTH(description), 0) AS text_bytes,' +
            ' content, description' +
            ' FROM items' +
            ' WHERE feed_id = ?' +
            ' AND (content IS NOT NULL OR description IS NOT NULL' +
            '  OR EXISTS' +
            '   (SELECT 1 FROM cached_images WHERE item_id = items.id))'
        const bind:(number|null)[] = [feed.id]
        if (openItemId !== null) {
            sql += ' AND id != ?'
            bind.push(openItemId)
        }
        sql += ' ORDER BY updated_at ASC'

        type ItemRow = {
            id:number
            text_bytes:number
            content:string|null
            description:string|null
        }
        const items = await queryDb<ItemRow>(db, sql, bind)

        let feedTrimmed = false
        let bucket:Cache|null = null

        for (const item of items) {
            if (currentSize <= maxSizeBytes) break

            const images = await queryDb<{
                url:string
                size_bytes:number
            }>(
                db,
                'SELECT url, size_bytes FROM cached_images WHERE item_id = ?',
                [item.id]
            )

            if (item.content !== null || item.description !== null) {
                await execDb(db, {
                    sql: 'UPDATE items SET content = NULL,' +
                        ' description = NULL WHERE id = ?',
                    bind: [item.id]
                })
            }

            let imageFreed = 0
            if (images.length > 0) {
                await execDb(db, {
                    sql: 'DELETE FROM cached_images WHERE item_id = ?',
                    bind: [item.id]
                })
                if (!bucket) {
                    bucket = await cacheStorage.open('rsss-images-v1')
                }
                for (const img of images) {
                    await bucket.delete(img.url)
                    imageFreed += img.size_bytes
                }
            }

            const freed = item.text_bytes + imageFreed
            currentSize -= freed
            bytesFreed += freed
            feedTrimmed = true
        }

        if (feedTrimmed) feedsTrimmed++
    }

    return { feedsTrimmed, bytesFreed }
}

export async function evictByAccountSizeCap (
    db:Sqlite3Db,
    cacheStorage:Pick<CacheStorage, 'open'> = caches
):Promise<{ bytesFreed:number }> {
    const cap = defaultAccountMaxSizeBytes.value

    const textRow = await queryOneDb<{ total:number|null }>(
        db,
        'SELECT SUM(COALESCE(LENGTH(content), 0) +' +
        ' COALESCE(LENGTH(description), 0)) AS total FROM items'
    )
    const imageRow = await queryOneDb<{ total:number|null }>(
        db,
        'SELECT SUM(size_bytes) AS total FROM cached_images'
    )
    let currentSize = (textRow?.total ?? 0) + (imageRow?.total ?? 0)
    if (currentSize <= cap) return { bytesFreed: 0 }

    const openItemId = getCurrentlyOpenItemId()
    let sql =
        'SELECT id,' +
        ' COALESCE(LENGTH(content), 0) +' +
        '  COALESCE(LENGTH(description), 0) AS text_bytes,' +
        ' content, description' +
        ' FROM items' +
        ' WHERE (content IS NOT NULL OR description IS NOT NULL' +
        '  OR EXISTS' +
        '   (SELECT 1 FROM cached_images WHERE item_id = items.id))'
    const bind:(number|null)[] = []
    if (openItemId !== null) {
        sql += ' AND id != ?'
        bind.push(openItemId)
    }
    sql += ' ORDER BY updated_at ASC'

    type ItemRow = {
        id:number
        text_bytes:number
        content:string|null
        description:string|null
    }
    const items = await queryDb<ItemRow>(db, sql, bind)

    let bytesFreed = 0
    let bucket:Cache|null = null

    for (const item of items) {
        if (currentSize <= cap) break

        const images = await queryDb<{
            url:string
            size_bytes:number
        }>(
            db,
            'SELECT url, size_bytes FROM cached_images WHERE item_id = ?',
            [item.id]
        )

        if (item.content !== null || item.description !== null) {
            await execDb(db, {
                sql: 'UPDATE items SET content = NULL,' +
                    ' description = NULL WHERE id = ?',
                bind: [item.id]
            })
        }

        let imageFreed = 0
        if (images.length > 0) {
            await execDb(db, {
                sql: 'DELETE FROM cached_images WHERE item_id = ?',
                bind: [item.id]
            })
            if (!bucket) {
                bucket = await cacheStorage.open('rsss-images-v1')
            }
            for (const img of images) {
                await bucket.delete(img.url)
                imageFreed += img.size_bytes
            }
        }

        const freed = item.text_bytes + imageFreed
        currentSize -= freed
        bytesFreed += freed
    }

    return { bytesFreed }
}
