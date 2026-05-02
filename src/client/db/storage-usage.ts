import { signal, batch } from '@preact/signals'
import type { Sqlite3Db } from './sqlite-init.js'
import { queryOneDb } from './local-db.js'
import { sumByFeed, sumTotal } from './cached-images.js'

export const feedStorageBytes = signal<Record<number, number>>({})
export const totalStorageBytes = signal<number>(0)

export function _resetStorageUsage ():void {
    batch(() => {
        feedStorageBytes.value = {}
        totalStorageBytes.value = 0
    })
}

export async function getTextBytesForFeed (
    db:Sqlite3Db,
    feedId:number
):Promise<number> {
    const row = await queryOneDb<{ total:number|null }>(
        db,
        `SELECT SUM(
            COALESCE(LENGTH(content), 0) +
            COALESCE(LENGTH(description), 0)
        ) AS total FROM items WHERE feed_id = ?`,
        [feedId]
    )
    return row?.total ?? 0
}

export async function getTextBytesTotal (db:Sqlite3Db):Promise<number> {
    const row = await queryOneDb<{ total:number|null }>(
        db,
        `SELECT SUM(
            COALESCE(LENGTH(content), 0) +
            COALESCE(LENGTH(description), 0)
        ) AS total FROM items`
    )
    return row?.total ?? 0
}

export async function loadStorageUsage (
    db:Sqlite3Db,
    feedIds:number[]
):Promise<void> {
    const perFeed:Record<number, number> = {}
    for (const feedId of feedIds) {
        const text = await getTextBytesForFeed(db, feedId)
        const images = await sumByFeed(db, feedId)
        perFeed[feedId] = text + images
    }
    const textTotal = await getTextBytesTotal(db)
    const imagesTotal = await sumTotal(db)
    batch(() => {
        feedStorageBytes.value = perFeed
        totalStorageBytes.value = textTotal + imagesTotal
    })
}
