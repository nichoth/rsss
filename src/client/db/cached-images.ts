import type { Sqlite3Db } from './sqlite-init.js'
import { execDb, queryOneDb } from './local-db.js'

export interface CachedImageRecord {
    url:string
    feedId:number
    itemId?:number|null
    sizeBytes:number
}

export async function recordCachedImage (
    db:Sqlite3Db,
    record:CachedImageRecord
):Promise<void> {
    await execDb(db, {
        sql: `
            INSERT OR IGNORE INTO cached_images
                (url, feed_id, item_id, size_bytes)
            VALUES (?, ?, ?, ?)
        `,
        bind: [
            record.url,
            record.feedId,
            record.itemId ?? null,
            record.sizeBytes
        ]
    })
}

export async function sumByFeed (
    db:Sqlite3Db,
    feedId:number
):Promise<number> {
    const row = await queryOneDb<{ total:number|null }>(
        db,
        'SELECT SUM(size_bytes) AS total' +
        ' FROM cached_images WHERE feed_id = ?',
        [feedId]
    )
    return row?.total ?? 0
}

export async function sumTotal (db:Sqlite3Db):Promise<number> {
    const row = await queryOneDb<{ total:number|null }>(
        db,
        'SELECT SUM(size_bytes) AS total FROM cached_images'
    )
    return row?.total ?? 0
}

export async function deleteByFeed (
    db:Sqlite3Db,
    feedId:number
):Promise<void> {
    await execDb(db, {
        sql: 'DELETE FROM cached_images WHERE feed_id = ?',
        bind: [feedId]
    })
}
