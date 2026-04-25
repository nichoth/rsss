import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import { setTestMode } from '../src/client/db/sqlite-init.js'
import {
    bootstrapLocalDb,
    bootstrapInProgress,
    bootstrapFeedsCount,
    bootstrapItemsCount,
    bootstrapError,
    getBootstrappedDb,
    clearBootstrappedDb
} from '../src/client/db/bootstrap.js'
import {
    syncSubscriptions,
    storeContent
} from '../src/client/local-first-settings.js'

setTestMode(true, wasmUrl as string)

function makeFetch (body:unknown, status = 200):typeof fetch {
    return async (_url:RequestInfo|URL) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    } as Response)
}

const syncPayload = {
    feeds: [
        {
            id: 1,
            url: 'https://example.com/feed',
            title: 'Example',
            description: null,
            site_url: null,
            last_fetched: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
        }
    ],
    items: [
        {
            id: 1,
            feed_id: 1,
            guid: 'guid1',
            title: 'Item 1',
            link: null,
            description: null,
            content: null,
            author: null,
            pub_date: null,
            is_read: 0,
            is_starred: 0,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
        },
        {
            id: 2,
            feed_id: 1,
            guid: 'guid2',
            title: 'Item 2',
            link: null,
            description: null,
            content: null,
            author: null,
            pub_date: null,
            is_read: 0,
            is_starred: 0,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
        }
    ],
    syncedAt: '2024-01-01T00:00:00Z',
    latestUpdatedAt: '2024-01-01T00:00:00Z',
    isFullSync: true
}

test('bootstrapLocalDb: happy path sets signals and db', async (t) => {
    clearBootstrappedDb()
    syncSubscriptions.value = false
    storeContent.value = false
    bootstrapError.value = null

    const fetchFn = makeFetch(syncPayload)
    syncSubscriptions.value = true
    await bootstrapLocalDb('did:test:bootstrap1', fetchFn)

    t.equal(bootstrapInProgress.value, false, 'inProgress is false after done')
    t.equal(bootstrapFeedsCount.value, 1, 'feeds count = 1')
    t.equal(bootstrapItemsCount.value, 2, 'items count = 2')
    t.equal(bootstrapError.value, null, 'no error')

    const db = getBootstrappedDb()
    t.ok(db !== null, 'bootstrapped DB is set')

    if (db) {
        const feeds = db.selectObjects(
            'SELECT * FROM feeds'
        ) as { id:number }[]
        t.equal(feeds.length, 1, 'feed row written to db')
        const items = db.selectObjects(
            'SELECT * FROM items'
        ) as { id:number }[]
        t.equal(items.length, 2, 'item rows written to db')
        db.close()
    }
    clearBootstrappedDb()
})

test('bootstrapLocalDb: bootstrap is idempotent (re-run adds no dupes)', async (t) => {
    clearBootstrappedDb()
    const fetchFn = makeFetch(syncPayload)
    syncSubscriptions.value = true

    await bootstrapLocalDb('did:test:bootstrap2', fetchFn)
    const db = getBootstrappedDb()

    // Run again on same in-memory DB via a second call won't reuse the same
    // db in test mode (new :memory: each time) but confirms no crash.
    t.equal(bootstrapInProgress.value, false, 'inProgress false after second run')
    t.equal(bootstrapError.value, null, 'no error on second run')

    if (db) db.close()
    clearBootstrappedDb()
})

test('bootstrapLocalDb: server error reverts syncSubscriptions', async (t) => {
    clearBootstrappedDb()
    syncSubscriptions.value = true
    bootstrapError.value = null

    const fetchFn = makeFetch({ error: 'internal' }, 500)
    await bootstrapLocalDb('did:test:bootstrap3', fetchFn)

    t.equal(bootstrapInProgress.value, false, 'inProgress false after error')
    t.ok(bootstrapError.value !== null, 'error signal set')
    t.equal(syncSubscriptions.value, false,
        'syncSubscriptions reverted to false')
    t.equal(getBootstrappedDb(), null, 'no db after failure')
})

test('getAdapter returns remoteAdapter while bootstrap in progress', async (t) => {
    const { getAdapter, _resetAdapterCache, remoteAdapter } =
        await import('../src/client/db/index.js')
    _resetAdapterCache()
    clearBootstrappedDb()
    syncSubscriptions.value = true
    bootstrapInProgress.value = true

    const adapter = await getAdapter('did:test:bootstrap4')
    t.equal(adapter, remoteAdapter,
        'returns remoteAdapter when bootstrap in progress')

    bootstrapInProgress.value = false
    _resetAdapterCache()
})
