import type { Sqlite3Db } from './sqlite-init.js'
import { execDb, queryDb } from './local-db.js'
import { deleteByFeed } from './cached-images.js'

export async function purgeStoredContent (db:Sqlite3Db):Promise<void> {
    await execDb(db, {
        sql: `UPDATE items
              SET content = NULL,
                  description = NULL
              WHERE content IS NOT NULL
                 OR description IS NOT NULL`
    })
}

export async function clearFeedCache (
    db:Sqlite3Db,
    feedId:number,
    cacheStorage:Pick<CacheStorage, 'open'> = caches
):Promise<string[]> {
    const rows = await queryDb<{ url:string }>(
        db,
        'SELECT url FROM cached_images WHERE feed_id = ?',
        [feedId]
    )
    const urls = rows.map(r => r.url)

    await execDb(db, {
        sql: `UPDATE items
              SET content = NULL,
                  description = NULL
              WHERE feed_id = ?`,
        bind: [feedId]
    })

    await deleteByFeed(db, feedId)

    if (urls.length > 0) {
        const bucket = await cacheStorage.open('rsss-images-v1')
        for (const url of urls) {
            await bucket.delete(url)
        }
    }

    return urls
}
