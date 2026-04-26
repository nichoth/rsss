import { test } from '@substrate-system/tapzero'
// esbuild --loader:.wasm=dataurl inlines the binary as a base64 data URL
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode,
    OPFSUnavailableError
} from '../src/client/db/sqlite-init.js'

setTestMode(true, wasmUrl as string)

test('openLocalDb creates feeds and items tables', async (t) => {
    const db = await openLocalDb('did:test:user1')
    try {
        const tables = db.selectValues(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ) as string[]
        t.ok(tables.includes('feeds'), 'feeds table exists')
        t.ok(tables.includes('items'), 'items table exists')
    } finally {
        db.close()
    }
})

test('openLocalDb creates expected indexes', async (t) => {
    const db = await openLocalDb('did:test:user2')
    try {
        const indexes = db.selectValues(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        ) as string[]
        t.ok(indexes.includes('idx_items_feed_id'), 'idx_items_feed_id exists')
        t.ok(indexes.includes('idx_items_is_read'), 'idx_items_is_read exists')
        t.ok(indexes.includes('idx_items_is_starred'),
            'idx_items_is_starred exists')
        t.ok(indexes.includes('idx_feeds_updated_at'),
            'idx_feeds_updated_at exists')
    } finally {
        db.close()
    }
})

test('openLocalDb enables foreign key enforcement', async (t) => {
    const db = await openLocalDb('did:test:foreign-keys')
    try {
        const enabled = db.selectValue('PRAGMA foreign_keys') as number
        t.equal(enabled, 1, 'foreign keys are enabled')
    } finally {
        db.close()
    }
})

test('openLocalDb schema is idempotent', async (t) => {
    const db = await openLocalDb('did:test:user3')
    const db2 = await openLocalDb('did:test:user3')
    try {
        const tables = db2.selectValues(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ) as string[]
        t.ok(tables.includes('feeds'), 'feeds still present after re-open')
        t.ok(tables.includes('items'), 'items still present after re-open')
    } finally {
        db.close()
        db2.close()
    }
})

test('OPFSUnavailableError is a typed Error subclass', (t) => {
    const err = new OPFSUnavailableError()
    t.ok(err instanceof Error, 'is an Error')
    t.equal(err.name, 'OPFSUnavailableError', 'has correct name')
})
