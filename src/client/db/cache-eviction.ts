import type { Sqlite3Db } from './sqlite-init.js'
import { queryDb, execDb } from './local-db.js'
import {
    getFeedCachePolicy,
    resolveEffectivePolicy
} from './feed-cache-policy.js'
import { getCurrentlyOpenItemId } from '../open-item-registry.js'

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
