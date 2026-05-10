import { DurableObject } from 'cloudflare:workers'
import { XMLParser } from 'fast-xml-parser'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
    TABLES_SQL,
    INDEXES_SQL,
    TRIGGERS_SQL,
    DEAD_LETTER_OUTBOX_SQL,
    ALL_FULL_CONTENT_STATUSES,
    FETCH_FULL_MIN_INTERVAL_MS
} from '../../shared/schema.js'
import { itemRouteCandidates } from '../../shared/item-route.js'
import {
    clampClientUpdatedAt,
    resolveLwwWrite
} from '../../shared/lww.js'
import {
    FeedFetchError,
    fetchFeedText,
    fetchOgImage,
    validateFeedUrl
} from '../feed-fetch.js'
import { fetchFullArticle } from '../article-fetch.js'

export interface Env {
    USER:DurableObjectNamespace<UserDO>
    SESSIONS:KVNamespace
    BLURHASH_KV:KVNamespace
    BLURHASH_QUEUE:Queue
    ASSETS:Fetcher
    AUTUMN_SECRET_KEY?:string
    AUTUMN_DISABLED?:string
    NODE_ENV?:string
}

interface Feed {
    id:number
    url:string
    title:string|null
    description:string|null
    site_url:string|null
    last_fetched:string|null
    last_error:string|null
    last_status:number|null
    created_at:string
    updated_at:string
}

type XmlValue = string | number | boolean | null | XmlObject | XmlValue[]

interface XmlObject {
    [key:string]:XmlValue
}

interface ParsedFeedItem {
    guid:string | null
    title:string | null
    link:string | null
    description:string | null
    content:string | null
    author:string | null
    pubDate:string | null
    imageUrl:string | null
}

interface ParsedFeed {
    title:string | null
    description:string | null
    link:string | null
    isTooLarge:boolean
    items:ParsedFeedItem[]
}

interface NewFeedItem {
    id:number
    link:string | null
    imageUrl:string | null
}

const FEED_XML_PARSER = new XMLParser({
    attributeNamePrefix: '@_',
    cdataPropName: '#cdata',
    ignoreAttributes: false,
    textNodeName: '#text',
    trimValues: true
})
const FEED_REFRESH_CONCURRENCY = 8
const OG_IMAGE_FETCH_CONCURRENCY = 4
const OG_IMAGE_FETCH_BUDGET_MS = 10_000
const FEED_REFRESH_INTERVAL_MS = 10 * 60 * 1000
const FEED_BACKOFF_MULTIPLIER = 2
const FEED_BACKOFF_CEILING_MS = 24 * 60 * 60 * 1000
const ACCOUNT_INACTIVITY_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000
const ACTIVITY_MARKER_COALESCE_MS = 60 * 1000
const MANUAL_REFRESH_LIMIT_MS = 60 * 1000
const MANUAL_REFRESH_STORAGE_PREFIX = 'manual_refresh:'
const ALARM_REFRESH_CURSOR_KEY = 'alarm_refresh_cursor'
const PENDING_DELETION_KEY = 'pending_deletion'
const MIGRATION_STATE_KEY = 'schema_migration'
const USER_DO_MIGRATION_VERSION = 5
const FEEDS_UPDATED_AT_BUMP_KEY = 'feeds_updated_at_bump_for_last_pulled_at'
const SYNC_PAGE_LIMIT = 500
const FETCH_FULL_THROTTLE_PREFIX = 'fetch_full:'
const MAX_PARSED_FEED_ITEMS = 1000
const MAX_FEED_TITLE_LENGTH = 8 * 1024
const MAX_FEED_DESCRIPTION_LENGTH = 64 * 1024
const MAX_FEED_CONTENT_LENGTH = 1024 * 1024
const FEED_TOO_LARGE_ERROR = 'feed too large'
const FEED_TOO_LARGE_STATUS = 413
const FEED_SYNC_COLUMNS = `
    id, url, title, description, site_url, last_fetched, last_pulled_at,
    last_error, last_status, created_at, updated_at
`
const ITEM_COLUMNS = `
    items.id, items.feed_id, items.guid, items.title, items.link,
    items.description, items.content, items.author, items.pub_date,
    items.thumbnail_url, items.og_image_url, items.blurhash,
    items.image_width, items.image_height, items.is_read,
    items.is_starred, items.created_at, items.updated_at,
    items.full_content, items.full_content_fetched_at,
    items.full_content_status
`
const ITEM_SYNC_COLUMNS = `
    ${ITEM_COLUMNS},
    feeds.title AS feed_title
`

function errorMessage (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function isDuplicateInsertError (err:unknown):boolean {
    const message = errorMessage(err).toLowerCase()

    return message.includes('sqlite_constraint_unique') ||
        message.includes('unique constraint failed')
}

interface MigrationState {
    migration_v?:number
}

interface AlarmRefreshCursor {
    last_feed_id?:number
}

interface PendingDeletion {
    scheduledFor:number
    did:string
}

interface ManualRefreshState {
    last_manual_refresh_at?:number
}

interface ManualRefreshLimit {
    retryAfterSeconds:number
}

interface FetchFullThrottleState {
    last_attempt_at?:number
}

interface FetchFullThrottleLimit {
    retryAfterSeconds:number
}

const POLL_FEED_KEY_PREFIX = 'poll:feed:'
const POLL_ACCOUNT_LAST_ACTIVE_AT_KEY = 'poll:account:last_active_at'
const POLL_ACCOUNT_LAST_ANY_SUCCESS_AT_KEY =
    'poll:account:last_any_success_at'

interface PollerFeedState {
    etag?:string
    lastModified?:string
    consecutiveFailures:number
    lastAttemptAt?:number
    lastSuccessfulAt?:number
    nextDueAt:number
}

interface AccountActivityMarker {
    lastActiveAt:number
}

function pollFeedKey (feedId:number):string {
    return `${POLL_FEED_KEY_PREFIX}${feedId}`
}

function fetchFullThrottleKey (itemId:number):string {
    return `${FETCH_FULL_THROTTLE_PREFIX}${itemId}`
}

function fetchFullRetryAfterSeconds (
    attemptedAt:number,
    now:number
):number {
    const remainingMs = FETCH_FULL_MIN_INTERVAL_MS - (now - attemptedAt)
    return Math.max(1, Math.ceil(remainingMs / 1000))
}

type SyncRowKind = 'feed' | 'item'

interface SyncCursor {
    updated_at:string
    id:number
    kind:SyncRowKind
}

interface SyncRow {
    kind:SyncRowKind
    row:Record<string, unknown>
    updated_at:string
    id:number
}

function encodeSyncCursor (row:SyncRow):string {
    return JSON.stringify({
        updated_at: row.updated_at,
        id: row.id,
        kind: row.kind
    })
}

function parseSyncCursor (value:string|undefined):SyncCursor|null {
    if (!value) return null

    try {
        const parsed = JSON.parse(value) as Partial<SyncCursor>
        if (
            typeof parsed.updated_at === 'string' &&
            typeof parsed.id === 'number' &&
            (parsed.kind === 'feed' || parsed.kind === 'item')
        ) {
            return {
                updated_at: parsed.updated_at,
                id: parsed.id,
                kind: parsed.kind
            }
        }
    } catch {
        return null
    }

    return null
}

function normalizeSyncLimit (value:string|undefined):number {
    const parsed = value ? Number(value) : SYNC_PAGE_LIMIT
    if (!Number.isFinite(parsed) || parsed < 1) return SYNC_PAGE_LIMIT
    return Math.min(Math.floor(parsed), SYNC_PAGE_LIMIT)
}

function syncRowCompare (a:SyncRow, b:SyncRow):number {
    if (a.updated_at !== b.updated_at) {
        return a.updated_at < b.updated_at ? -1 : 1
    }
    if (a.id !== b.id) return a.id - b.id
    return a.kind.localeCompare(b.kind)
}

function syncCursorWhere (
    cursor:SyncCursor|null,
    since:string|undefined,
    tableName:string,
    kind:SyncRowKind
):{ sql:string; bind:unknown[] } {
    const conditions:string[] = []
    const bind:unknown[] = []

    if (since) {
        conditions.push(`${tableName}.updated_at > ?`)
        bind.push(since)
    }

    if (cursor) {
        conditions.push(`(
            ${tableName}.updated_at > ? OR (
                ${tableName}.updated_at = ? AND (
                    ${tableName}.id > ? OR (
                        ${tableName}.id = ? AND ? > ?
                    )
                )
            )
        )`)
        bind.push(
            cursor.updated_at,
            cursor.updated_at,
            cursor.id,
            cursor.id,
            kind,
            cursor.kind
        )
    }

    return {
        sql: conditions.length > 0
            ? `WHERE ${conditions.join(' AND ')}`
            : 'WHERE 1 = 1',
        bind
    }
}

function lwwClientUpdatedAt (value:string|undefined):string|undefined {
    if (value === undefined) return undefined

    const result = clampClientUpdatedAt(value)
    if (result.wasClamped) {
        console.warn('[DO] Clamped client_updated_at', {
            client_updated_at: value,
            clamped_client_updated_at: result.clientUpdatedAt
        })
    }

    return result.clientUpdatedAt
}

function manualRefreshStorageKey (feedId:number):string {
    return `${MANUAL_REFRESH_STORAGE_PREFIX}${feedId}`
}

function isRecentManualRefresh (
    refreshedAt:number|undefined,
    now:number
):boolean {
    return typeof refreshedAt === 'number' &&
        Number.isFinite(refreshedAt) &&
        now - refreshedAt < MANUAL_REFRESH_LIMIT_MS
}

function manualRefreshRetryAfterSeconds (
    refreshedAt:number,
    now:number
):number {
    const remainingMs = MANUAL_REFRESH_LIMIT_MS - (now - refreshedAt)
    return Math.max(1, Math.ceil(remainingMs / 1000))
}

/**
 * Store feeds and items for a single user.
 * Each user gets their own DO with its own SQLite database.
 *
 * Uses the Hibernation API:
 * - DO hibernates between requests to minimize cost
 * - Uses alarms for periodic feed polling (every 10 min)
 * - State persists in SQLite across hibernation cycles
 */
export class UserDO extends DurableObject<Env> {
    private app: Hono
    private sql: SqlStorage
    private manualRefreshClaims?:Map<number, number>
    private subscribers = new Set<
        ReadableStreamDefaultController<Uint8Array>
    >()

    private encoder = new TextEncoder()
    private keepaliveInterval:ReturnType<typeof setInterval>|null = null

    constructor (ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.app = this.createRouter()

        ctx.blockConcurrencyWhile(async () => {
            await this.initDatabase()

            // Schedule initial alarm if none exists
            // This wakes the DO periodically to refresh feeds
            const currentAlarm = await ctx.storage.getAlarm()
            if (!currentAlarm) {
                // Set first alarm 10 minutes from now
                await ctx.storage.setAlarm(
                    Date.now() + FEED_REFRESH_INTERVAL_MS
                )
            }
        })
    }

    private async initDatabase () {
        this.sql.exec('PRAGMA foreign_keys = ON;')

        // 1. Create tables (shared schema)
        this.sql.exec(TABLES_SQL)

        // 2. Server-only migrations: backfill columns on rows that existed
        // before those columns were added.
        // Must run after table creation but before updated_at indexes.
        const migrationState = await this.ctx.storage.get<MigrationState>(
            MIGRATION_STATE_KEY
        )
        if (migrationState?.migration_v !== USER_DO_MIGRATION_VERSION) {
            this.migrateAddUpdatedAt()
            this.migrateAddFeedFailureColumns()
            this.migrateAddItemThumbnail()
            this.migrateAddItemImageMetadata()
            this.migrateAddLastPulledAt()
            this.migrateAddItemFullContent()
            await this.ctx.storage.put(MIGRATION_STATE_KEY, {
                migration_v: USER_DO_MIGRATION_VERSION
            })
        }

        // One-time bump: re-emit every feed row to clients so they
        // pick up the newly-projected `last_pulled_at` column.
        // Guarded by its own storage key so it runs at most once
        // per UserDO regardless of the schema migration version.
        const feedsBumpDone = await this.ctx.storage.get<boolean>(
            FEEDS_UPDATED_AT_BUMP_KEY
        )
        if (!feedsBumpDone) {
            this.sql.exec(
                "UPDATE feeds SET updated_at = datetime('now')"
            )
            await this.ctx.storage.put(FEEDS_UPDATED_AT_BUMP_KEY, true)
        }

        // 3. Create indexes and triggers (shared schema) - idempotent
        this.sql.exec(INDEXES_SQL)
        this.sql.exec(TRIGGERS_SQL)
        this.sql.exec(DEAD_LETTER_OUTBOX_SQL)
    }

    /**
     * Migration: Add updated_at column to existing tables
     */
    private migrateAddUpdatedAt () {
        // Check if feeds has updated_at
        const feedsCols = this.sql.exec('PRAGMA table_info(feeds)').toArray()
        const feedsHasUpdatedAt = feedsCols.some((col: unknown) =>
            (col as { name: string }).name === 'updated_at'
        )
        if (!feedsHasUpdatedAt) {
            // SQLite doesn't allow non-constant defaults in ALTER TABLE
            this.sql.exec('ALTER TABLE feeds ADD COLUMN updated_at TEXT')
            this.sql.exec('UPDATE feeds SET updated_at = ' +
                "COALESCE(created_at, datetime('now'))")
        }

        // Check if items has updated_at
        const itemsCols = this.sql.exec('PRAGMA table_info(items)').toArray()
        const itemsHasUpdatedAt = itemsCols.some((col: unknown) =>
            (col as { name: string }).name === 'updated_at'
        )
        if (!itemsHasUpdatedAt) {
            // SQLite doesn't allow non-constant defaults in ALTER TABLE
            this.sql.exec('ALTER TABLE items ADD COLUMN updated_at TEXT')
            this.sql.exec('UPDATE items SET updated_at = COALESCE(created_at, ' +
                " datetime('now'))")
        }
    }

    private migrateAddFeedFailureColumns () {
        const columns = this.sql.exec('PRAGMA table_info(feeds)').toArray()
        const hasLastError = columns.some((col: unknown) =>
            (col as { name:string }).name === 'last_error'
        )
        const hasLastStatus = columns.some((col: unknown) =>
            (col as { name:string }).name === 'last_status'
        )

        if (!hasLastError) {
            this.sql.exec('ALTER TABLE feeds ADD COLUMN last_error TEXT')
        }
        if (!hasLastStatus) {
            this.sql.exec('ALTER TABLE feeds ADD COLUMN last_status INTEGER')
        }
    }

    private migrateAddItemThumbnail () {
        const columns = this.sql.exec('PRAGMA table_info(items)').toArray()
        const hasThumbnailUrl = columns.some((col: unknown) =>
            (col as { name:string }).name === 'thumbnail_url'
        )

        if (!hasThumbnailUrl) {
            this.sql.exec('ALTER TABLE items ADD COLUMN thumbnail_url TEXT')
        }
    }

    private migrateAddItemFullContent () {
        const cols = this.sql.exec('PRAGMA table_info(items)').toArray()
        const has = (name:string) => cols.some(
            (col:unknown) => (col as { name:string }).name === name
        )
        if (!has('full_content')) {
            this.sql.exec(
                'ALTER TABLE items ADD COLUMN full_content TEXT'
            )
        }
        if (!has('full_content_fetched_at')) {
            this.sql.exec(
                'ALTER TABLE items ADD COLUMN full_content_fetched_at TEXT'
            )
        }
        if (!has('full_content_status')) {
            this.sql.exec(
                'ALTER TABLE items ADD COLUMN full_content_status TEXT'
            )
        }
    }

    private migrateAddItemImageMetadata () {
        const cols = this.sql.exec('PRAGMA table_info(items)').toArray()
        const has = (name:string) => cols.some(
            (col:unknown) => (col as { name:string }).name === name
        )
        const columns = [
            ['og_image_url', 'TEXT'],
            ['blurhash', 'TEXT'],
            ['image_width', 'INTEGER'],
            ['image_height', 'INTEGER']
        ]

        for (const [name, type] of columns) {
            if (!has(name)) {
                this.sql.exec(
                    `ALTER TABLE items ADD COLUMN ${name} ${type}`
                )
            }
        }
    }

    private migrateAddLastPulledAt () {
        const columns = this.sql.exec(
            'PRAGMA table_info(feeds)'
        ).toArray()
        const hasLastPulledAt = columns.some((col: unknown) =>
            (col as { name:string }).name === 'last_pulled_at'
        )

        if (!hasLastPulledAt) {
            this.sql.exec(
                'ALTER TABLE feeds ADD COLUMN last_pulled_at TEXT'
            )
            this.sql.exec(`
                UPDATE feeds SET last_pulled_at = (
                    SELECT MAX(pub_date) FROM items
                    WHERE items.feed_id = feeds.id
                    AND pub_date IS NOT NULL
                )
            `)
        }
    }

    getFeedsWithUpdates ():string[] {
        const rows = this.sql.exec(`
            SELECT feeds.id FROM feeds
            WHERE EXISTS (
                SELECT 1 FROM items
                WHERE items.feed_id = feeds.id
                AND (
                    feeds.last_pulled_at IS NULL
                    OR items.pub_date > feeds.last_pulled_at
                )
            )
        `).toArray() as Array<{ id:number }>
        return rows.map(r => String(r.id))
    }

    getFeedUpdateCounts ():Record<string, number> {
        const rows = this.sql.exec(`
            SELECT
                feeds.id AS id,
                COUNT(items.id) AS pending_count
            FROM feeds
            LEFT JOIN items
                ON items.feed_id = feeds.id
                AND items.pub_date IS NOT NULL
                AND (
                    feeds.last_pulled_at IS NULL
                    OR items.pub_date > feeds.last_pulled_at
                )
            GROUP BY feeds.id
        `).toArray() as Array<{
            id:number|string
            pending_count:number|string|null
        }>

        return rows.reduce<Record<string, number>>((counts, row) => {
            counts[String(row.id)] = Number(row.pending_count ?? 0)
            return counts
        }, {})
    }

    private advanceFeedCursor (feedId:number):void {
        this.sql.exec(
            `UPDATE feeds SET last_pulled_at = (
                SELECT MAX(pub_date) FROM items
                WHERE feed_id = ? AND pub_date IS NOT NULL
            ) WHERE id = ?`,
            feedId,
            feedId
        )
        const stillUnsynced = this.getFeedsWithUpdates()
            .includes(String(feedId))
        if (!stillUnsynced) {
            this.broadcast('feed-updates-cleared', {
                feedIds: [String(feedId)]
            })
        }
    }

    private createRouter (): Hono {
        const app = new Hono()

        // Health check
        app.get('/health', (c) => {
            return c.json({ status: 'ok', service: 'do' })
        })

        // Server-sent events stream. Broadcasts state-change
        // notifications (e.g. feed-updated) to all open clients
        // for this user.
        app.get('/events', () => {
            let owned:ReadableStreamDefaultController<Uint8Array>|null
                = null
            const stream = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    owned = controller
                    controller.enqueue(
                        this.encoder.encode(': connected\n\n')
                    )
                    this.subscribers.add(controller)
                    this.ensureKeepalive()
                },
                cancel: () => {
                    if (owned) {
                        this.subscribers.delete(owned)
                        owned = null
                    }
                    this.maybeStopKeepalive()
                }
            })

            return new Response(stream, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    'X-Accel-Buffering': 'no'
                }
            })
        })

        // Server-vs-client divergence indicator. Single round-trip
        // source for the header "n updates / up to date" pill (see
        // specs/008-fix-up-to-date-dot/contracts/feed-status-endpoint.md).
        // Mounted under the same `/api` proxy as `/feeds`, so it
        // inherits `requireAuth` from `dataRouter` without
        // `requireEntitlement` — free users must reach this endpoint.
        app.get('/feed-status', async (c) => {
            const feedUpdateCounts = this.getFeedUpdateCounts()
            const totalPending = Object.values(feedUpdateCounts)
                .reduce((sum, count) => sum + count, 0)
            await this.maybeKickCatchUp(Date.now())
            return c.json({ feedUpdateCounts, totalPending })
        })

        // List all feeds
        app.get('/feeds', (c) => {
            const feeds = this.sql.exec(
                'SELECT * FROM feeds ORDER BY title ASC'
            ).toArray()
            const feedsWithUpdates = this.getFeedsWithUpdates()
            const feedUpdateStatus = feedsWithUpdates.length > 0 ?
                'updates' :
                'synced'
            const feedUpdateCounts = this.getFeedUpdateCounts()
            return c.json({
                feeds,
                feedUpdateStatus,
                feedsWithUpdates,
                feedUpdateCounts
            })
        })

        // Add a new feed
        app.post('/feeds', async (c) => {
            const body = await c.req.json<{
                url:string
                client_op_id?:string
                client_updated_at?:string
            }>()
            const clientUpdatedAt = lwwClientUpdatedAt(
                body.client_updated_at
            )
            console.log('[DO] POST /feeds', body.url)

            if (!body.url) {
                return c.json(
                    { error: 'URL is required' },
                    400
                )
            }

            try {
                body.url = await validateFeedUrl(body.url)
            } catch (_err) {
                const err = _err as FeedFetchError
                return c.json(
                    { error: err.message },
                    err.status as ContentfulStatusCode
                )
            }

            try {
                // Check if feed already exists
                const existing = this.sql.exec(
                    'SELECT id FROM feeds WHERE url = ?',
                    body.url
                ).toArray()

                if (existing.length > 0) {
                    console.log(
                        '[DO] Feed already exists:',
                        body.url
                    )
                    const existingFeed = this.sql.exec(
                        'SELECT * FROM feeds WHERE url = ?',
                        body.url
                    ).one() as Record<string, unknown> | null
                    if (
                        clientUpdatedAt !== undefined &&
                        existingFeed
                    ) {
                        if (body.client_op_id !== undefined) {
                            return c.json({ feed: existingFeed })
                        }
                        const serverTs = existingFeed.updated_at as string|null
                        if (
                            resolveLwwWrite(serverTs, clientUpdatedAt) ===
                            'conflict'
                        ) {
                            return c.json({ feed: existingFeed }, 409)
                        }
                    }
                    return c.json(
                        { error: 'Feed already exists' },
                        409
                    )
                }

                // Insert the feed
                this.sql.exec(
                    'INSERT INTO feeds (url) VALUES (?)',
                    body.url
                )
                console.log(
                    '[DO] Inserted feed:',
                    body.url
                )

                const feed = this.sql.exec(
                    'SELECT * FROM feeds WHERE url = ?',
                    body.url
                ).one()
                console.log(
                    '[DO] Feed row:',
                    JSON.stringify(feed)
                )

                this.ctx.waitUntil(this.fetchFeed(feed as unknown as Feed))

                return c.json(
                    { feed },
                    201
                )
            } catch (_err) {
                const err = _err as Error
                console.error(
                    '[DO] Error adding feed:',
                    err.message,
                    err.stack
                )
                return c.json(
                    { error: 'Failed to add feed' },
                    500
                )
            }
        })

        // Get a specific feed
        app.get('/feeds/:id', (c) => {
            const id = parseInt(c.req.param('id'), 10)
            const feed = this.sql.exec('SELECT * FROM feeds WHERE id = ?', id).one()

            if (!feed) {
                return c.json({ error: 'Feed not found' }, 404)
            }

            return c.json({ feed })
        })

        // Pending items for a feed (not yet pulled past last_pulled_at)
        app.get('/feeds/:id/pending', (c) => {
            const id = parseInt(c.req.param('id'), 10)
            const rows = this.sql.exec(
                `SELECT CAST(id AS TEXT) AS id,
                    COALESCE(title, '') AS title,
                    pub_date AS published_at
                FROM items
                WHERE feed_id = ?
                  AND pub_date IS NOT NULL
                  AND pub_date > COALESCE(
                    (SELECT last_pulled_at FROM feeds WHERE id = ?),
                    '1970-01-01'
                  )
                ORDER BY pub_date DESC
                LIMIT 50`,
                id,
                id
            ).toArray() as Array<{
                id:string
                title:string
                published_at:string
            }>
            return c.json({ items: rows })
        })

        // Delete a feed
        app.delete('/feeds/:id', async (c) => {
            const id = parseInt(c.req.param('id'), 10)
            const body:{
                client_op_id?:string
                client_updated_at?:string
            } = await c.req.json<{
                client_op_id?:string
                client_updated_at?:string
            }>().catch(() => ({}))
            const clientUpdatedAt = lwwClientUpdatedAt(
                body.client_updated_at
            )

            const feed = this.sql.exec(
                'SELECT * FROM feeds WHERE id = ?', id
            ).one() as Record<string, unknown> | null
            if (!feed) {
                if (body.client_op_id !== undefined) {
                    return c.json({ success: true })
                }
                return c.json({ error: 'Feed not found' }, 404)
            }

            if (clientUpdatedAt !== undefined) {
                const serverTs = feed.updated_at as string | null
                if (
                    resolveLwwWrite(serverTs, clientUpdatedAt) ===
                    'conflict'
                ) {
                    return c.json({ feed }, 409)
                }
            }

            this.sql.exec('DELETE FROM feeds WHERE id = ?', id)
            await this.deletePollerFeedState(id)
            return c.json({ success: true })
        })

        // Refresh a specific feed
        app.post('/feeds/:id/refresh', async (c) => {
            const id = parseInt(c.req.param('id'), 10)
            const feed = this.sql.exec('SELECT * FROM feeds WHERE id = ?', id).one() as unknown as Feed | null

            if (!feed) {
                return c.json({ error: 'Feed not found' }, 404)
            }

            const limit = await this.claimManualFeedRefresh(feed.id)
            if (limit) {
                const response = c.json({
                    error: 'Feed refresh rate limited'
                }, 429)
                response.headers.set(
                    'Retry-After',
                    String(limit.retryAfterSeconds)
                )
                return response
            }

            try {
                await validateFeedUrl(feed.url)
                await this.fetchFeed(feed)
                this.advanceFeedCursor(feed.id)
            } catch (_err) {
                const err = _err as FeedFetchError
                return c.json(
                    { error: err.message },
                    err.status as ContentfulStatusCode
                )
            }
            return c.json({ success: true })
        })

        // Refresh all feeds. Kick fetches off in waitUntil and
        // return immediately - clients see per-feed completion via
        // SSE (`feed-updated`) and the whole-batch completion via
        // `refresh-complete`.
        app.post('/feeds/refresh', (c) => {
            const feeds = this.sql.exec('SELECT * FROM feeds')
                .toArray() as unknown as Feed[]

            this.ctx.waitUntil((async () => {
                await Promise.all(feeds.map(async feed => {
                    await this.fetchFeed(feed)
                    this.advanceFeedCursor(feed.id)
                }))
                this.broadcast('refresh-complete', {
                    refreshed: feeds.length
                })
            })())

            return c.json({ success: true, queued: feeds.length })
        })

        // List items with optional filters
        app.get('/items', (c) => {
            const feedId = c.req.query('feed_id')
            const isRead = c.req.query('is_read')
            const isStarred = c.req.query('is_starred')
            const limit = parseInt(c.req.query('limit') || '50', 10)
            const offset = parseInt(c.req.query('offset') || '0', 10)

            // Reading-list cursor filter: only items whose feed has been
            // refreshed at least once and whose pub_date is at-or-before
            // that cursor are visible. Items with NULL pub_date are
            // admitted unconditionally so they cannot become invisible.
            const cursorPredicate =
                ' AND (' +
                ' items.pub_date IS NULL' +
                ' OR (' +
                ' feeds.last_pulled_at IS NOT NULL' +
                ' AND items.pub_date <= feeds.last_pulled_at' +
                ' )' +
                ' )'

            let query = `SELECT ${ITEM_SYNC_COLUMNS} ` +
                'FROM items JOIN feeds ON items.feed_id = feeds.id WHERE 1=1' +
                cursorPredicate
            const params: (string | number)[] = []

            if (feedId) {
                query += ' AND items.feed_id = ?'
                params.push(parseInt(feedId, 10))
            }

            if (isRead !== undefined) {
                query += ' AND items.is_read = ?'
                params.push(isRead === 'true' ? 1 : 0)
            }

            if (isStarred !== undefined) {
                query += ' AND items.is_starred = ?'
                params.push(isStarred === 'true' ? 1 : 0)
            }

            query += ' ORDER BY items.pub_date DESC, items.created_at DESC' +
                ' LIMIT ? OFFSET ?'
            params.push(limit, offset)

            const items = this.sql.exec(query, ...params).toArray()

            // Get total count -- mirror the cursor predicate so
            // pagination totals match the visible page.
            let countQuery = 'SELECT COUNT(*) as count FROM items' +
                ' JOIN feeds ON items.feed_id = feeds.id WHERE 1=1' +
                cursorPredicate
            const countParams: (string | number)[] = []

            if (feedId) {
                countQuery += ' AND items.feed_id = ?'
                countParams.push(parseInt(feedId, 10))
            }
            if (isRead !== undefined) {
                countQuery += ' AND items.is_read = ?'
                countParams.push(isRead === 'true' ? 1 : 0)
            }
            if (isStarred !== undefined) {
                countQuery += ' AND items.is_starred = ?'
                countParams.push(isStarred === 'true' ? 1 : 0)
            }

            const countResult = this.sql.exec(countQuery, ...countParams).one() as { count: number }

            return c.json({
                items,
                total: countResult.count,
                limit,
                offset
            })
        })

        // Get unread count
        app.get('/items/by-route', (c) => {
            const route = c.req.query('route')
            if (!route) {
                return c.json(
                    { error: 'Route is required' },
                    400
                )
            }

            const routeCandidates = itemRouteCandidates(route)
            if (routeCandidates.length === 0) {
                return c.json(
                    { error: 'Route is required' },
                    400
                )
            }

            const routeQuery = routeCandidates
                .map(() => 'items.link = ?')
                .join(' OR ')

            const item = this.sql.exec(
                `SELECT ${ITEM_SYNC_COLUMNS}
                 FROM items
                 JOIN feeds ON items.feed_id = feeds.id
                 WHERE items.link IS NOT NULL
                 AND (${routeQuery})
                 ORDER BY items.pub_date DESC, items.created_at DESC
                 LIMIT 1`,
                ...routeCandidates
            ).one()

            if (!item) {
                return c.json({ error: 'Item not found' }, 404)
            }

            return c.json({ item })
        })

        app.get('/items/count', (c) => {
            const unread = this.sql.exec('SELECT COUNT(*) as count FROM items WHERE is_read = 0').one() as { count: number }
            const starred = this.sql.exec('SELECT COUNT(*) as count FROM items WHERE is_starred = 1').one() as { count: number }
            const total = this.sql.exec('SELECT COUNT(*) as count FROM items').one() as { count: number }
            const perFeedRows = this.sql.exec(
                'SELECT feed_id, COUNT(*) as unread FROM items' +
                ' WHERE is_read = 0 GROUP BY feed_id'
            ).toArray() as { feed_id:number; unread:number }[]
            const perFeed:Record<string, number> = {}
            for (const row of perFeedRows) {
                perFeed[String(row.feed_id)] = row.unread
            }

            return c.json({
                unread: unread.count,
                starred: starred.count,
                total: total.count,
                perFeed
            })
        })

        // Mark item as read/unread
        app.patch('/items/:id', async (c) => {
            const id = parseInt(c.req.param('id'), 10)
            const body = await c.req.json<{
                is_read?:boolean
                is_starred?:boolean
                client_updated_at?:string
            }>()
            const clientUpdatedAt = lwwClientUpdatedAt(
                body.client_updated_at
            )

            const item = this.sql.exec(
                `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, id
            ).one() as Record<string, unknown> | null
            if (!item) {
                return c.json({ error: 'Item not found' }, 404)
            }

            if (clientUpdatedAt !== undefined) {
                const serverTs = item.updated_at as string | null
                if (
                    resolveLwwWrite(serverTs, clientUpdatedAt) ===
                    'conflict'
                ) {
                    return c.json({ item }, 409)
                }
            }

            if (body.is_read !== undefined) {
                this.sql.exec(
                    'UPDATE items SET is_read = ? WHERE id = ?',
                    body.is_read ? 1 : 0, id
                )
            }

            if (body.is_starred !== undefined) {
                this.sql.exec(
                    'UPDATE items SET is_starred = ? WHERE id = ?',
                    body.is_starred ? 1 : 0, id
                )
            }

            const updated = this.sql.exec(
                `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, id
            ).one()
            return c.json({ item: updated })
        })

        // Mark all items as read
        app.post('/items/mark-all-read', async (c) => {
            const body:{
                feed_id?:number
                client_updated_at?:string
            } = await c.req.json<{
                feed_id?:number
                client_updated_at?:string
            }>().catch(() => ({ feed_id: undefined }))
            const clientUpdatedAt = lwwClientUpdatedAt(
                body.client_updated_at
            )

            if (clientUpdatedAt !== undefined) {
                // LWW: check if any items in scope are newer than client
                let newerItems:unknown[]
                if (body.feed_id !== undefined) {
                    newerItems = this.sql.exec(
                        `SELECT ${ITEM_COLUMNS} FROM items ` +
                        'WHERE feed_id = ?' +
                        ' AND updated_at > ?',
                        body.feed_id,
                        clientUpdatedAt
                    ).toArray()
                } else {
                    newerItems = this.sql.exec(
                        `SELECT ${ITEM_COLUMNS} FROM items ` +
                        'WHERE updated_at > ?',
                        clientUpdatedAt
                    ).toArray()
                }
                if (newerItems.length > 0) {
                    return c.json({ items: newerItems }, 409)
                }
            }

            if (body.feed_id !== undefined) {
                this.sql.exec(
                    'UPDATE items SET is_read = 1 WHERE feed_id = ?',
                    body.feed_id
                )
            } else {
                this.sql.exec('UPDATE items SET is_read = 1')
            }

            return c.json({ success: true })
        })

        // Sync endpoint - returns all data changed since a timestamp
        app.get('/sync', (c) => {
            const since = c.req.query('since')
            const cursor = parseSyncCursor(c.req.query('cursor'))
            const limit = normalizeSyncLimit(c.req.query('limit'))
            const feedWhere = syncCursorWhere(cursor, since, 'feeds', 'feed')
            const itemWhere = syncCursorWhere(cursor, since, 'items', 'item')

            const feedsPage = this.sql.exec(
                `SELECT ${FEED_SYNC_COLUMNS}
                 FROM feeds
                 ${feedWhere.sql}
                 ORDER BY updated_at ASC, id ASC
                 LIMIT ?`,
                ...feedWhere.bind,
                limit + 1
            ).toArray() as Record<string, unknown>[]

            const itemsPage = this.sql.exec(
                `SELECT ${ITEM_SYNC_COLUMNS}
                 FROM items
                 JOIN feeds ON items.feed_id = feeds.id
                 ${itemWhere.sql}
                 ORDER BY items.updated_at ASC, items.id ASC
                 LIMIT ?`,
                ...itemWhere.bind,
                limit + 1
            ).toArray() as Record<string, unknown>[]

            const combinedRows:SyncRow[] = [
                ...feedsPage.map((row) => ({
                    kind: 'feed' as const,
                    row,
                    updated_at: row.updated_at as string,
                    id: row.id as number
                })),
                ...itemsPage.map((row) => ({
                    kind: 'item' as const,
                    row,
                    updated_at: row.updated_at as string,
                    id: row.id as number
                }))
            ].sort(syncRowCompare)

            const pageRows = combinedRows.slice(0, limit)
            const hasMore = combinedRows.length > limit
            const nextCursor = hasMore && pageRows.length > 0
                ? encodeSyncCursor(pageRows[pageRows.length - 1])
                : null
            const feeds = pageRows
                .filter((row) => row.kind === 'feed')
                .map((row) => row.row)
            const items = pageRows
                .filter((row) => row.kind === 'item')
                .map((row) => row.row)

            // Get the latest updated_at timestamp for the client to store
            const latestFeed = this.sql.exec(
                'SELECT MAX(updated_at) as latest FROM feeds'
            ).one() as { latest: string | null }
            const latestItem = this.sql.exec(
                'SELECT MAX(updated_at) as latest FROM items'
            ).one() as { latest: string | null }

            // Use SQLite-compatible format so string
            // comparisons work for incremental sync.
            // SQLite datetime('now') => '2026-02-10 00:08:00'
            // JS toISOString()       => '2026-02-10T00:08:00.000Z'
            // Space < 'T' in ASCII, which breaks `>` queries.
            const syncedAt = new Date()
                .toISOString()
                .replace('T', ' ')
                .replace('Z', '')
                .split('.')[0]
            const latestUpdatedAt = [
                latestFeed?.latest,
                latestItem?.latest
            ]
                .filter(Boolean)
                .sort()
                .pop() || syncedAt

            return c.json({
                feeds,
                items,
                hasMore,
                nextCursor,
                syncedAt,
                latestUpdatedAt,
                isFullSync: !since
            })
        })

        // Fetch the full article body for an item (on-demand). Returns
        // the row after the attempt completed; the caller distinguishes
        // success vs failure by inspecting full_content_status.
        app.post('/items/:id/fetch-full', async (c) => {
            const rawId = c.req.param('id')
            const id = Number.parseInt(rawId, 10)
            if (!Number.isFinite(id) || id <= 0 || String(id) !== rawId) {
                return c.json({ error: 'invalid_id' }, 400)
            }

            let body:{ force?:boolean } = {}
            const text = await c.req.text()
            if (text) {
                try {
                    body = JSON.parse(text) as { force?:boolean }
                    if (typeof body !== 'object' || body === null) {
                        return c.json({ error: 'invalid_body' }, 400)
                    }
                } catch {
                    return c.json({ error: 'invalid_body' }, 400)
                }
            }
            const force = body.force === true

            const item = this.sql.exec(
                `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, id
            ).one() as Record<string, unknown> | null
            if (!item) {
                return c.json({ error: 'Item not found' }, 404)
            }

            const link = (item.link as string|null) || ''
            if (!link) {
                return c.json({ error: 'item_has_no_link' }, 409)
            }

            // Cache hit: row is already succeeded and force not set.
            if (
                !force &&
                item.full_content_status === 'succeeded' &&
                typeof item.full_content === 'string' &&
                item.full_content.length > 0
            ) {
                return c.json({ item })
            }

            if (!force) {
                const limit = await this.claimFetchFullAttempt(id)
                if (limit) {
                    const response = c.json({
                        error: 'fetch_full_throttled'
                    }, 429)
                    response.headers.set(
                        'Retry-After',
                        String(limit.retryAfterSeconds)
                    )
                    return response
                }
            }

            const result = await this.doFetchFullArticle(link)
            if (!ALL_FULL_CONTENT_STATUSES.includes(result.status)) {
                // Defensive: should never happen.
                return c.json({ error: 'invalid_status' }, 500)
            }

            if (result.status === 'succeeded') {
                this.sql.exec(
                    'UPDATE items SET full_content = ?, ' +
                    'full_content_fetched_at = ?, ' +
                    'full_content_status = ? WHERE id = ?',
                    result.html,
                    result.fetchedAt,
                    'succeeded',
                    id
                )
            } else {
                // Preserve any prior full_content on failure.
                this.sql.exec(
                    'UPDATE items SET ' +
                    "full_content_fetched_at = datetime('now'), " +
                    'full_content_status = ? WHERE id = ?',
                    result.status,
                    id
                )
            }

            const updated = this.sql.exec(
                `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, id
            ).one()
            return c.json({ item: updated })
        })

        app.get('/internal/account/deletion', async (c) => {
            const pending = await this.ctx.storage.get<PendingDeletion>(
                PENDING_DELETION_KEY
            )
            return c.json({
                pendingDeletion: pending ?
                    { scheduledFor: pending.scheduledFor } :
                    null
            })
        })

        app.post('/internal/account/deletion', async (c) => {
            const body = await c.req.json<{
                scheduledFor?:number;
                did?:string
            }>().catch(() => ({} as {
                scheduledFor?:number;
                did?:string
            }))
            const scheduledFor = Number(body.scheduledFor)
            const did = typeof body.did === 'string' ? body.did : ''
            if (!Number.isFinite(scheduledFor) || !did) {
                return c.json({ error: 'invalid_body' }, 400)
            }

            const record:PendingDeletion = { scheduledFor, did }
            await this.ctx.storage.put(PENDING_DELETION_KEY, record)

            // If the deletion is already due, run it on the next alarm
            // tick by setting an immediate alarm.
            if (scheduledFor <= Date.now()) {
                await this.ctx.storage.setAlarm(Date.now())
            }

            return c.json({ scheduledFor })
        })

        app.delete('/internal/account/deletion', async (c) => {
            await this.ctx.storage.delete(PENDING_DELETION_KEY)
            return c.json({ ok: true })
        })

        return app
    }

    /**
     * Send an SSE event to all connected subscribers for this user.
     */
    private broadcast (event:string, data:unknown):void {
        if (!this.subscribers) return
        if (this.subscribers.size === 0) return

        const payload = `event: ${event}\n` +
            `data: ${JSON.stringify(data)}\n\n`
        const bytes = this.encoder.encode(payload)

        for (const controller of this.subscribers) {
            try {
                controller.enqueue(bytes)
            } catch {
                this.subscribers.delete(controller)
            }
        }
        this.maybeStopKeepalive()
    }

    private ensureKeepalive ():void {
        if (this.keepaliveInterval) return
        this.keepaliveInterval = setInterval(() => {
            if (this.subscribers.size === 0) {
                this.maybeStopKeepalive()
                return
            }
            const bytes = this.encoder.encode(':keepalive\n\n')
            for (const controller of this.subscribers) {
                try {
                    controller.enqueue(bytes)
                } catch {
                    this.subscribers.delete(controller)
                }
            }
        }, 20_000)
    }

    private maybeStopKeepalive ():void {
        if (
            this.keepaliveInterval &&
            this.subscribers.size === 0
        ) {
            clearInterval(this.keepaliveInterval)
            this.keepaliveInterval = null
        }
    }

    protected async doFetchFeedText (
        url:string,
        validators?:{ etag?:string; lastModified?:string }
    ):Promise<{
        text:string
        url:string
        notModified:boolean
        etag?:string
        lastModified?:string
    }> {
        return fetchFeedText(url, validators ? { validators } : {})
    }

    protected async doFetchFullArticle (link:string) {
        return fetchFullArticle(link)
    }

    /**
     * Fetch and parse an RSS/Atom feed
     */
    private async fetchFeed (feed: Feed): Promise<void> {
        console.log(
            '[DO] fetchFeed:',
            feed.url
        )
        const priorState = await this.readPollerFeedState(feed.id)
        const startedAt = Date.now()
        try {
            const fetched = await this.doFetchFeedText(
                feed.url,
                priorState ?
                    {
                        etag: priorState.etag,
                        lastModified: priorState.lastModified
                    } :
                    undefined
            )

            if (fetched.notModified) {
                // 304: feed has not changed. Do NOT parse, do NOT
                // insert, do NOT broadcast feed-updates-available
                // (FR-005, FR-010). Refresh per-account success
                // bookkeeping and reset the per-feed backoff. The
                // `finally` block below still emits feed-updated so
                // dashboards see a heartbeat.
                await this.writePollerFeedState(feed.id, {
                    etag: priorState?.etag,
                    lastModified: priorState?.lastModified,
                    consecutiveFailures: 0,
                    lastAttemptAt: startedAt,
                    lastSuccessfulAt: startedAt,
                    nextDueAt: startedAt + FEED_REFRESH_INTERVAL_MS
                })
                await this.writeLastAnySuccess(startedAt)
                return
            }

            console.log(
                '[DO] Feed response length:',
                fetched.text.length
            )
            const parsedFeed = this.parseFeed(fetched.text)
            console.log(
                '[DO] Parsed items:',
                parsedFeed.items.length,
                'title:',
                parsedFeed.title
            )

            // Update feed metadata
            if (parsedFeed.title || parsedFeed.description || parsedFeed.link) {
                this.sql.exec(
                    `UPDATE feeds SET
                        title = COALESCE(?, title),
                        description = COALESCE(?, description),
                        site_url = COALESCE(?, site_url),
                        last_fetched = datetime('now'),
                        last_error = NULL,
                        last_status = NULL
                    WHERE id = ?`,
                    parsedFeed.title,
                    parsedFeed.description,
                    parsedFeed.link,
                    feed.id
                )
            }

            // Persist the canonical URL when the server redirected us. Skip
            // when another row already owns the resolved URL (UNIQUE
            // constraint would fail) — the redirect still works correctly,
            // we just don't optimize that row.
            if (fetched.url !== feed.url) {
                const collision = this.sql.exec(
                    'SELECT id FROM feeds WHERE url = ? AND id != ?',
                    fetched.url,
                    feed.id
                ).toArray()
                if (collision.length === 0) {
                    this.sql.exec(
                        `UPDATE feeds SET
                            url = ?,
                            updated_at = datetime('now')
                        WHERE id = ?`,
                        fetched.url,
                        feed.id
                    )
                }
            }

            // Insert new items
            const newItems:NewFeedItem[] = []
            for (const item of parsedFeed.items) {
                const guid = item.guid || item.link || item.title || ''
                if (!guid) continue

                try {
                    const result = this.sql.exec(
                        `INSERT OR IGNORE INTO items
                            (
                                feed_id, guid, title, link, description,
                                content, author, pub_date
                            )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        feed.id,
                        guid,
                        item.title,
                        item.link,
                        item.description,
                        item.content,
                        item.author,
                        item.pubDate
                    )

                    if (this.rowsWritten(result) > 0) {
                        const row = this.sql.exec(
                            `SELECT id FROM items
                            WHERE feed_id = ? AND guid = ?`,
                            feed.id,
                            guid
                        ).one() as { id:number } | null

                        if (row) {
                            newItems.push({
                                id: row.id,
                                link: item.link,
                                imageUrl: item.imageUrl
                            })
                        }
                    }
                } catch (err) {
                    if (isDuplicateInsertError(err)) continue

                    const message = errorMessage(err)

                    console.error(
                        `Error inserting feed item for ${feed.url}:`,
                        err
                    )
                    this.sql.exec(
                        `UPDATE feeds SET
                            last_error = ?,
                            last_status = ?
                        WHERE id = ?`,
                        message,
                        500,
                        feed.id
                    )
                    return
                }
            }

            await this.updateNewItemThumbnails(newItems)

            if (newItems.length > 0) {
                // Send canonical pending count for the touched feed so
                // the client is a passive renderer of state. Re-broadcast
                // even when the feed was already in the unsynced set
                // (Acceptance 2.2): the displayed count must keep up
                // with the server.
                const allCounts = this.getFeedUpdateCounts()
                const feedIdStr = String(feed.id)
                this.broadcast('feed-updates-available', {
                    feedUpdateCounts: {
                        [feedIdStr]: allCounts[feedIdStr] ?? 0
                    }
                })
            }

            if (parsedFeed.isTooLarge) {
                this.sql.exec(
                    `UPDATE feeds SET
                        last_error = ?,
                        last_status = ?
                    WHERE id = ?`,
                    FEED_TOO_LARGE_ERROR,
                    FEED_TOO_LARGE_STATUS,
                    feed.id
                )
            }

            const successAt = Date.now()
            await this.writePollerFeedState(feed.id, {
                etag: fetched.etag,
                lastModified: fetched.lastModified,
                consecutiveFailures: 0,
                lastAttemptAt: startedAt,
                lastSuccessfulAt: successAt,
                nextDueAt: successAt + FEED_REFRESH_INTERVAL_MS
            })
            await this.writeLastAnySuccess(successAt)
        } catch (err) {
            console.error(`Error fetching feed ${feed.url}:`, err)
            this.sql.exec(
                `UPDATE feeds SET
                    last_error = ?,
                    last_status = ?
                WHERE id = ?`,
                errorMessage(err),
                err instanceof FeedFetchError ? err.status : 500,
                feed.id
            )
            try {
                const failures = (priorState?.consecutiveFailures ?? 0) + 1
                const backoffMs = Math.min(
                    FEED_REFRESH_INTERVAL_MS *
                        Math.pow(FEED_BACKOFF_MULTIPLIER, failures),
                    FEED_BACKOFF_CEILING_MS
                )
                await this.writePollerFeedState(feed.id, {
                    etag: priorState?.etag,
                    lastModified: priorState?.lastModified,
                    consecutiveFailures: failures,
                    lastAttemptAt: startedAt,
                    lastSuccessfulAt: priorState?.lastSuccessfulAt,
                    nextDueAt: startedAt + backoffMs
                })
            } catch (writeErr) {
                console.error(
                    '[DO] writePollerFeedState (failure path) failed',
                    writeErr
                )
            }
        } finally {
            this.broadcast('feed-updated', { feedId: feed.id })
        }
    }

    private rowsWritten (result:unknown):number {
        if (!result || typeof result !== 'object') return 0

        const rowsWritten = (result as { rowsWritten?:unknown }).rowsWritten

        return typeof rowsWritten === 'number' ? rowsWritten : 0
    }

    private async updateNewItemThumbnails (
        items:NewFeedItem[]
    ):Promise<void> {
        if (items.length === 0) return

        let nextItemIndex = 0
        const controller = new AbortController()
        const deadline = Date.now() + OG_IMAGE_FETCH_BUDGET_MS
        const timeout = setTimeout(() => {
            controller.abort()
        }, OG_IMAGE_FETCH_BUDGET_MS)
        const workerCount = Math.min(
            OG_IMAGE_FETCH_CONCURRENCY,
            items.length
        )
        const workers = Array.from({ length: workerCount }, async () => {
            while (Date.now() < deadline) {
                const item = items[nextItemIndex]
                nextItemIndex++
                if (!item) return

                await this.updateNewItemThumbnail(
                    item,
                    deadline,
                    controller.signal
                )
            }
        })
        const results = await Promise.allSettled(workers)

        clearTimeout(timeout)

        for (const result of results) {
            if (result.status === 'rejected') {
                console.error('Error updating item thumbnail:', result.reason)
            }
        }
    }

    private async updateNewItemThumbnail (
        item:NewFeedItem,
        deadline:number,
        signal:AbortSignal
    ):Promise<void> {
        try {
            const thumbnailUrl = await this.resolveNewItemThumbnail(
                item,
                deadline,
                signal
            )
            if (!thumbnailUrl) return

            this.sql.exec(
                `UPDATE items SET thumbnail_url = ?
                WHERE id = ? AND thumbnail_url IS NULL`,
                thumbnailUrl,
                item.id
            )
        } catch (err) {
            console.error('Error updating item thumbnail:', err)
        }
    }

    private async resolveNewItemThumbnail (
        item:NewFeedItem,
        deadline:number,
        signal:AbortSignal
    ):Promise<string | null> {
        if (!item.link) return item.imageUrl

        const ogImage = await this.fetchOgImageBeforeDeadline(
            item.link,
            deadline,
            signal
        )

        return ogImage || item.imageUrl
    }

    private async fetchOgImageBeforeDeadline (
        link:string,
        deadline:number,
        signal:AbortSignal
    ):Promise<string | null> {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) return null

        let timeout:ReturnType<typeof setTimeout>|null = null
        const timedOut = Symbol('og-timeout')
        const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
            timeout = setTimeout(() => {
                resolve(timedOut)
            }, remainingMs)
        })

        try {
            const result = await Promise.race([
                fetchOgImage(link, { signal }),
                timeoutPromise
            ])

            return result === timedOut ? null : result
        } catch (_err) {
            return null
        } finally {
            if (timeout) clearTimeout(timeout)
        }
    }

    /**
     * Parse RSS or Atom feed XML
     */
    private parseFeed (xml: string): ParsedFeed {
        const doc = FEED_XML_PARSER.parse(xml) as XmlObject
        const rss = this.asObject(this.getChild(doc, ['rss', 'rdf:RDF']))
        const channel = rss ?
            this.asObject(this.getChild(rss, ['channel'])) :
            null
        const atom = this.asObject(this.getChild(doc, ['feed']))

        if (channel) return this.parseRss(channel)
        if (atom) return this.parseAtom(atom)

        return {
            title: null,
            description: null,
            link: null,
            isTooLarge: false,
            items: []
        }
    }

    private parseRss (channel: XmlObject) {
        let isTooLarge = false
        const markTooLarge = () => {
            isTooLarge = true
        }
        const title = this.capText(
            this.getText(channel, ['title']),
            MAX_FEED_TITLE_LENGTH,
            markTooLarge
        )
        const description = this.capText(
            this.getText(channel, ['description']),
            MAX_FEED_DESCRIPTION_LENGTH,
            markTooLarge
        )
        const link = this.getText(channel, ['link'])
        const items: ParsedFeedItem[] = []
        const itemNodes = this.asArray(this.getChild(channel, ['item']))
        const cappedItemNodes = itemNodes.slice(0, MAX_PARSED_FEED_ITEMS)

        if (itemNodes.length > MAX_PARSED_FEED_ITEMS) {
            isTooLarge = true
        }

        for (const itemNode of cappedItemNodes) {
            const item = this.asObject(itemNode)
            if (!item) continue

            const itemLink = this.getText(item, ['link'])
            items.push({
                guid: this.getText(item, ['guid', 'id']) ||
                    itemLink,
                title: this.capText(
                    this.getText(item, ['title', 'media:title']),
                    MAX_FEED_TITLE_LENGTH,
                    markTooLarge
                ),
                link: itemLink,
                description: this.capText(
                    this.getText(item, ['description']),
                    MAX_FEED_DESCRIPTION_LENGTH,
                    markTooLarge
                ),
                content: this.capText(
                    this.getText(item, [
                        'content:encoded',
                        'encoded',
                        'content'
                    ]),
                    MAX_FEED_CONTENT_LENGTH,
                    markTooLarge
                ),
                author: this.getText(item, [
                    'author',
                    'dc:creator',
                    'creator'
                ]),
                pubDate: this.parseDate(this.getText(item, ['pubDate'])),
                imageUrl: this.resolveImageUrl(
                    this.getRssItemImage(item),
                    itemLink,
                    link
                )
            })
        }

        return { title, description, link, isTooLarge, items }
    }

    private parseAtom (feed: XmlObject) {
        let isTooLarge = false
        const markTooLarge = () => {
            isTooLarge = true
        }
        const title = this.capText(
            this.getText(feed, ['title']),
            MAX_FEED_TITLE_LENGTH,
            markTooLarge
        )
        const description = this.capText(
            this.getText(feed, ['subtitle']),
            MAX_FEED_DESCRIPTION_LENGTH,
            markTooLarge
        )
        const link = this.getLinkHref(this.getChild(feed, ['link']))
        const items: ParsedFeedItem[] = []
        const entries = this.asArray(this.getChild(feed, ['entry']))
        const cappedEntries = entries.slice(0, MAX_PARSED_FEED_ITEMS)

        if (entries.length > MAX_PARSED_FEED_ITEMS) {
            isTooLarge = true
        }

        for (const entryNode of cappedEntries) {
            const entry = this.asObject(entryNode)
            if (!entry) continue

            const author = this.asObject(this.getChild(entry, ['author']))
            const entryLink = this.getLinkHref(this.getChild(entry, ['link']))

            items.push({
                guid: this.getText(entry, ['id']),
                title: this.capText(
                    this.getText(entry, ['title']),
                    MAX_FEED_TITLE_LENGTH,
                    markTooLarge
                ),
                link: entryLink,
                description: this.capText(
                    this.getText(entry, ['summary']),
                    MAX_FEED_DESCRIPTION_LENGTH,
                    markTooLarge
                ),
                content: this.capText(
                    this.getText(entry, ['content']),
                    MAX_FEED_CONTENT_LENGTH,
                    markTooLarge
                ),
                author: author ? this.getText(author, ['name']) : null,
                pubDate: this.parseDate(
                    this.getText(entry, ['published']) ||
                    this.getText(entry, ['updated'])
                ),
                imageUrl: this.resolveImageUrl(
                    this.getAtomEntryImage(entry),
                    entryLink,
                    link
                )
            })
        }

        return { title, description, link, isTooLarge, items }
    }

    private extractFirstImgSrc (html:string | null):string | null {
        if (!html) return null

        const match = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)
        return match?.[1]?.trim() || null
    }

    private resolveImageUrl (
        candidate:string | null,
        itemLink:string | null,
        feedLink:string | null
    ):string | null {
        if (!candidate) return null

        const base = itemLink || feedLink

        try {
            const url = base ? new URL(candidate, base) : new URL(candidate)

            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                return null
            }

            return url.href
        } catch {
            return null
        }
    }

    private getRssItemImage (item:XmlObject):string | null {
        const thumbnail = this.firstAttr(
            this.getChild(item, ['media:thumbnail']),
            '@_url'
        )
        if (thumbnail) return thumbnail

        const mediaContent = this.firstMediaImageAttr(
            this.getChild(item, ['media:content']),
            '@_url'
        )
        if (mediaContent) return mediaContent

        const enclosure = this.firstMediaImageAttr(
            this.getChild(item, ['enclosure']),
            '@_url'
        )
        if (enclosure) return enclosure

        return this.extractFirstImgSrc(this.getText(item, [
            'content:encoded',
            'encoded',
            'content',
            'description'
        ]))
    }

    private getAtomEntryImage (entry:XmlObject):string | null {
        const thumbnail = this.firstAttr(
            this.getChild(entry, ['media:thumbnail']),
            '@_url'
        )
        if (thumbnail) return thumbnail

        for (const linkValue of this.asArray(this.getChild(entry, ['link']))) {
            const link = this.asObject(linkValue)
            if (!link) continue

            const rel = this.textValue(link['@_rel'])
            const type = this.textValue(link['@_type'])
            const href = this.textValue(link['@_href'])
            if (rel === 'enclosure' && this.isImageType(type) && href) {
                return href
            }
        }

        return this.extractFirstImgSrc(this.getText(entry, [
            'content',
            'summary'
        ]))
    }

    private firstAttr (
        value:XmlValue | undefined,
        attrName:string
    ):string | null {
        for (const candidate of this.asArray(value)) {
            const node = this.asObject(candidate)
            const attr = node ? this.textValue(node[attrName]) : null
            if (attr) return attr
        }

        return null
    }

    private firstMediaImageAttr (
        value:XmlValue | undefined,
        attrName:string
    ):string | null {
        for (const candidate of this.asArray(value)) {
            const node = this.asObject(candidate)
            if (!node) continue

            const medium = this.textValue(node['@_medium'])
            const type = this.textValue(node['@_type'])
            const attr = this.textValue(node[attrName])
            const isImage = medium === 'image' || this.isImageType(type)
            if (isImage && attr) return attr
        }

        return null
    }

    private isImageType (value:string | null):boolean {
        return value?.toLowerCase().startsWith('image/') ?? false
    }

    private capText (
        value:string | null,
        maxLength:number,
        markTooLarge:() => void
    ):string | null {
        if (value === null) return null
        if (value.length <= maxLength) return value

        markTooLarge()
        return value.slice(0, maxLength)
    }

    private getLinkHref (value:XmlValue | undefined):string | null {
        const links = this.asArray(value)
        let fallback:string | null = null

        for (const linkValue of links) {
            const link = this.asObject(linkValue)
            if (!link) {
                fallback = fallback || this.textValue(linkValue)
                continue
            }

            const href = this.textValue(link['@_href'])
            const rel = this.textValue(link['@_rel'])
            if (!href) continue
            if (!rel || rel === 'alternate') return href
            fallback = fallback || href
        }

        return fallback
    }

    private getText (
        node:XmlObject,
        names:string[]
    ):string | null {
        const value = this.getChild(node, names)
        return this.textValue(value)
    }

    private getChild (
        node:XmlObject,
        names:string[]
    ):XmlValue | undefined {
        for (const name of names) {
            if (node[name] !== undefined) return node[name]
        }

        return undefined
    }

    private textValue (value:XmlValue | undefined):string | null {
        if (value === undefined || value === null) return null
        if (typeof value === 'string') return value.trim() || null
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value)
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                const text = this.textValue(item)
                if (text) return text
            }

            return null
        }

        return this.textValue(value['#cdata']) ||
            this.textValue(value['#text'])
    }

    private asObject (value:XmlValue | undefined):XmlObject | null {
        if (!value || Array.isArray(value) || typeof value !== 'object') {
            return null
        }

        return value
    }

    private asArray (value:XmlValue | undefined):XmlValue[] {
        if (value === undefined || value === null) return []
        return Array.isArray(value) ? value : [value]
    }

    private parseDate (dateStr: string | null): string | null {
        if (!dateStr) return null

        try {
            const date = new Date(dateStr)
            if (isNaN(date.getTime())) return null
            return date.toISOString()
        } catch {
            return null
        }
    }

    /**
     * Handle incoming requests - routes to internal Hono app
     */
    async fetch (request: Request): Promise<Response> {
        return this.app.fetch(request)
    }

    private getManualRefreshClaims ():Map<number, number> {
        if (!this.manualRefreshClaims) {
            this.manualRefreshClaims = new Map()
        }

        return this.manualRefreshClaims
    }

    private async claimManualFeedRefresh (
        feedId:number,
        now = Date.now()
    ):Promise<ManualRefreshLimit|null> {
        const claims = this.getManualRefreshClaims()
        const claimedAt = claims.get(feedId)

        if (isRecentManualRefresh(claimedAt, now)) {
            return {
                retryAfterSeconds: manualRefreshRetryAfterSeconds(
                    claimedAt as number,
                    now
                )
            }
        }

        claims.set(feedId, now)

        const key = manualRefreshStorageKey(feedId)
        const stored = await this.ctx.storage.get<ManualRefreshState>(key)
        const storedAt = stored?.last_manual_refresh_at

        if (isRecentManualRefresh(storedAt, now)) {
            claims.set(feedId, storedAt as number)
            return {
                retryAfterSeconds: manualRefreshRetryAfterSeconds(
                    storedAt as number,
                    now
                )
            }
        }

        await this.ctx.storage.put(key, {
            last_manual_refresh_at: now
        })

        return null
    }

    private async claimFetchFullAttempt (
        itemId:number,
        now = Date.now()
    ):Promise<FetchFullThrottleLimit|null> {
        const key = fetchFullThrottleKey(itemId)
        const stored = await this.ctx.storage
            .get<FetchFullThrottleState>(key)
        const storedAt = stored?.last_attempt_at

        if (
            typeof storedAt === 'number' &&
            Number.isFinite(storedAt) &&
            now - storedAt < FETCH_FULL_MIN_INTERVAL_MS
        ) {
            return {
                retryAfterSeconds: fetchFullRetryAfterSeconds(storedAt, now)
            }
        }

        await this.ctx.storage.put(key, { last_attempt_at: now })
        return null
    }

    private async readPollerFeedState (
        feedId:number
    ):Promise<PollerFeedState|undefined> {
        return this.ctx.storage.get<PollerFeedState>(pollFeedKey(feedId))
    }

    private async writePollerFeedState (
        feedId:number,
        state:PollerFeedState
    ):Promise<void> {
        const sanitized:PollerFeedState = {
            consecutiveFailures: state.consecutiveFailures,
            nextDueAt: state.nextDueAt
        }
        if (state.etag !== undefined) sanitized.etag = state.etag
        if (state.lastModified !== undefined) {
            sanitized.lastModified = state.lastModified
        }
        if (state.lastAttemptAt !== undefined) {
            sanitized.lastAttemptAt = state.lastAttemptAt
        }
        if (state.lastSuccessfulAt !== undefined) {
            sanitized.lastSuccessfulAt = state.lastSuccessfulAt
        }
        await this.ctx.storage.put(pollFeedKey(feedId), sanitized)
    }

    private async deletePollerFeedState (feedId:number):Promise<void> {
        await this.ctx.storage.delete(pollFeedKey(feedId))
    }

    private async readAccountActivity (
    ):Promise<AccountActivityMarker|undefined> {
        return this.ctx.storage.get<AccountActivityMarker>(
            POLL_ACCOUNT_LAST_ACTIVE_AT_KEY
        )
    }

    private async writeAccountActivity (now:number):Promise<void> {
        const existing = await this.readAccountActivity()
        if (
            existing &&
            typeof existing.lastActiveAt === 'number' &&
            Number.isFinite(existing.lastActiveAt) &&
            now - existing.lastActiveAt < ACTIVITY_MARKER_COALESCE_MS
        ) {
            return
        }
        await this.ctx.storage.put<AccountActivityMarker>(
            POLL_ACCOUNT_LAST_ACTIVE_AT_KEY,
            { lastActiveAt: now }
        )
    }

    private async readLastAnySuccess ():Promise<number|undefined> {
        const stored = await this.ctx.storage.get<{ lastAnySuccessAt:number }>(
            POLL_ACCOUNT_LAST_ANY_SUCCESS_AT_KEY
        )
        const value = stored?.lastAnySuccessAt
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value
        }
        return undefined
    }

    private async writeLastAnySuccess (now:number):Promise<void> {
        const prev = await this.readLastAnySuccess()
        const next = typeof prev === 'number' ? Math.max(prev, now) : now
        await this.ctx.storage.put(
            POLL_ACCOUNT_LAST_ANY_SUCCESS_AT_KEY,
            { lastAnySuccessAt: next }
        )
    }

    private async maybeKickCatchUp (now:number):Promise<void> {
        const prev = await this.readAccountActivity()
        const prevLastActiveAt = prev?.lastActiveAt
        const lastAnySuccessAt = await this.readLastAnySuccess()
        const trigger = (
            prevLastActiveAt === undefined ||
            now - prevLastActiveAt > ACCOUNT_INACTIVITY_THRESHOLD_MS ||
            lastAnySuccessAt === undefined ||
            lastAnySuccessAt < now - FEED_REFRESH_INTERVAL_MS
        )
        await this.writeAccountActivity(now)
        if (trigger) {
            this.ctx.waitUntil(this.refreshFeedBatches())
        }
    }

    /**
     * Alarm handler for periodic feed refresh
     */
    async alarm (): Promise<void> {
        const pending = await this.ctx.storage.get<PendingDeletion>(
            PENDING_DELETION_KEY
        )
        if (pending && Date.now() >= pending.scheduledFor) {
            await this.executeAccountDeletion(pending.did)
            return
        }

        await this.scheduleNextFeedRefresh()

        // Inactivity gate (FR-008, SC-005): accounts that have not
        // been active beyond the threshold incur zero polling cost
        // until the next sign-in/page-load advances last_active_at.
        // The next alarm has already been re-armed above, so we keep
        // ticking on cadence and resume work as soon as the account
        // becomes active again.
        const activity = await this.readAccountActivity()
        if (
            activity &&
            Date.now() - activity.lastActiveAt >
                ACCOUNT_INACTIVITY_THRESHOLD_MS
        ) {
            return
        }

        await this.refreshFeedBatches()
    }

    /**
     * Permanently delete the user's data. Wipes the per-user
     * Durable Object storage (SQLite tables and KV-style state),
     * removes their KV entries on the main worker, and best-effort
     * deletes the Autumn customer record.
     */
    private async executeAccountDeletion (did:string):Promise<void> {
        console.log('[DO] executeAccountDeletion', did)

        // Cancel/delete the Autumn customer first so they aren't
        // billed past this point. Best-effort: a missing customer
        // (free tier) is not an error.
        try {
            const { cancelCustomer } = await import(
                '../autumn-billing.js'
            )
            await cancelCustomer(this.env, did)
        } catch (err) {
            console.error('[DO] cancelCustomer failed', err)
        }

        // Remove the user's KV entries on the main worker namespace.
        try {
            await Promise.all([
                this.env.SESSIONS.delete(`user:${did}`),
                this.env.SESSIONS.delete(`billing:${did}`),
                this.env.SESSIONS.delete(`billing_pending_email:${did}`),
                this.env.SESSIONS.delete(`billing_contact_email:${did}`)
            ])
        } catch (err) {
            console.error('[DO] KV cleanup failed', err)
        }

        // Drop SQLite tables for clean slate.
        try {
            this.sql.exec('DROP TABLE IF EXISTS items')
            this.sql.exec('DROP TABLE IF EXISTS feeds')
            this.sql.exec('DROP TABLE IF EXISTS dead_letter_outbox')
        } catch (err) {
            console.error('[DO] DROP TABLE failed', err)
        }

        // Wipe DO state (alarm, cursor, pending deletion, etc.)
        await this.ctx.storage.deleteAll()
    }

    private async scheduleNextFeedRefresh ():Promise<void> {
        await this.ctx.storage.setAlarm(
            Date.now() + FEED_REFRESH_INTERVAL_MS
        )
    }

    private async refreshFeedBatches ():Promise<void> {
        let cursor = await this.getAlarmRefreshCursor()
        const sweepNow = Date.now()
        const manualClaims = this.manualRefreshClaims

        while (true) {
            const batch = this.selectFeedRefreshBatch(cursor)
            if (batch.length === 0) {
                await this.ctx.storage.delete(ALARM_REFRESH_CURSOR_KEY)
                return
            }

            const due:Feed[] = []
            for (const feed of batch) {
                if (manualClaims?.has(feed.id)) continue
                const state = await this.readPollerFeedState(feed.id)
                if (state === undefined || state.nextDueAt <= sweepNow) {
                    due.push(feed)
                }
            }

            if (due.length > 0) {
                await this.refreshFeeds(due)
            }

            const lastFeed = batch[batch.length - 1]
            if (!lastFeed) return

            cursor = lastFeed.id
            await this.ctx.storage.put(ALARM_REFRESH_CURSOR_KEY, {
                last_feed_id: cursor
            })
        }
    }

    private async getAlarmRefreshCursor ():Promise<number> {
        const cursor = await this.ctx.storage.get<AlarmRefreshCursor>(
            ALARM_REFRESH_CURSOR_KEY
        )
        const lastFeedId = cursor?.last_feed_id
        if (
            typeof lastFeedId === 'number' &&
            Number.isFinite(lastFeedId) &&
            lastFeedId > 0
        ) {
            return lastFeedId
        }

        return 0
    }

    private selectFeedRefreshBatch (cursor:number):Feed[] {
        if (cursor > 0) {
            return this.sql.exec(
                `SELECT * FROM feeds
                WHERE id > ?
                ORDER BY id ASC
                LIMIT ?`,
                cursor,
                FEED_REFRESH_CONCURRENCY
            ).toArray() as unknown as Feed[]
        }

        return this.sql.exec(
            `SELECT * FROM feeds
            ORDER BY id ASC
            LIMIT ?`,
            FEED_REFRESH_CONCURRENCY
        ).toArray() as unknown as Feed[]
    }

    private async refreshFeeds (feeds:Feed[]):Promise<void> {
        let nextFeedIndex = 0
        const workerCount = Math.min(FEED_REFRESH_CONCURRENCY, feeds.length)
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextFeedIndex < feeds.length) {
                const feed = feeds[nextFeedIndex]
                nextFeedIndex++
                if (feed) await this.fetchFeed(feed)
            }
        })

        await Promise.all(workers)
    }
}
