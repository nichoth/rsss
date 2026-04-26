import { DurableObject } from 'cloudflare:workers'
import { XMLParser } from 'fast-xml-parser'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
    TABLES_SQL,
    INDEXES_SQL,
    TRIGGERS_SQL,
    DEAD_LETTER_OUTBOX_SQL
} from '../../shared/schema.js'
import { itemRouteCandidates } from '../../shared/item-route.js'
import {
    FeedFetchError,
    fetchFeedText,
    validateFeedUrl
} from '../feed-fetch.js'

export interface Env {
    USER:DurableObjectNamespace<UserDO>
    SESSIONS:KVNamespace
    ASSETS:Fetcher
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

const FEED_XML_PARSER = new XMLParser({
    attributeNamePrefix: '@_',
    cdataPropName: '#cdata',
    ignoreAttributes: false,
    textNodeName: '#text',
    trimValues: true
})
const FEED_REFRESH_CONCURRENCY = 8

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

    constructor (ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.initDatabase()
        this.app = this.createRouter()

        // Schedule initial alarm if none exists
        // This wakes the DO periodically to refresh feeds
        ctx.blockConcurrencyWhile(async () => {
            const currentAlarm = await ctx.storage.getAlarm()
            if (!currentAlarm) {
                // Set first alarm 10 minutes from now
                await ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000)
            }
        })
    }

    private initDatabase () {
        this.sql.exec('PRAGMA foreign_keys = ON;')

        // 1. Create tables (shared schema)
        this.sql.exec(TABLES_SQL)

        // 2. Server-only migrations: backfill columns on rows that existed
        // before those columns were added.
        // Must run after table creation but before updated_at indexes.
        this.migrateAddUpdatedAt()
        this.migrateAddFeedFailureColumns()

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

    private createRouter (): Hono {
        const app = new Hono()

        app.use('*', cors())

        // Health check
        app.get('/health', (c) => {
            return c.json({ status: 'ok', service: 'do' })
        })

        // List all feeds
        app.get('/feeds', (c) => {
            const feeds = this.sql.exec(
                'SELECT * FROM feeds ORDER BY title ASC'
            ).toArray()
            return c.json({ feeds })
        })

        // Add a new feed
        app.post('/feeds', async (c) => {
            const body = await c.req.json<{
                url:string
                client_updated_at?:string
            }>()
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
                        body.client_updated_at !== undefined &&
                        existingFeed
                    ) {
                        const serverTs = existingFeed.updated_at as string|null
                        if (serverTs && serverTs > body.client_updated_at) {
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
            const id = parseInt(c.req.param('id'))
            const feed = this.sql.exec('SELECT * FROM feeds WHERE id = ?', id).one()

            if (!feed) {
                return c.json({ error: 'Feed not found' }, 404)
            }

            return c.json({ feed })
        })

        // Delete a feed
        app.delete('/feeds/:id', async (c) => {
            const id = parseInt(c.req.param('id'))
            const body:{ client_updated_at?:string } = await c.req.json<{
                client_updated_at?:string
            }>().catch(() => ({}))

            const feed = this.sql.exec(
                'SELECT * FROM feeds WHERE id = ?', id
            ).one() as Record<string, unknown> | null
            if (!feed) {
                return c.json({ error: 'Feed not found' }, 404)
            }

            if (body.client_updated_at !== undefined) {
                const serverTs = feed.updated_at as string | null
                if (serverTs && serverTs > body.client_updated_at) {
                    return c.json({ feed }, 409)
                }
            }

            this.sql.exec('DELETE FROM feeds WHERE id = ?', id)
            return c.json({ success: true })
        })

        // Refresh a specific feed
        app.post('/feeds/:id/refresh', async (c) => {
            const id = parseInt(c.req.param('id'))
            const feed = this.sql.exec('SELECT * FROM feeds WHERE id = ?', id).one() as unknown as Feed | null

            if (!feed) {
                return c.json({ error: 'Feed not found' }, 404)
            }

            try {
                await validateFeedUrl(feed.url)
                await this.fetchFeed(feed)
            } catch (_err) {
                const err = _err as FeedFetchError
                return c.json(
                    { error: err.message },
                    err.status as ContentfulStatusCode
                )
            }
            return c.json({ success: true })
        })

        // Refresh all feeds
        app.post('/feeds/refresh', async (c) => {
            const feeds = this.sql.exec('SELECT * FROM feeds').toArray() as unknown as Feed[]

            await Promise.all(feeds.map(feed => this.fetchFeed(feed)))

            return c.json({ success: true, refreshed: feeds.length })
        })

        // List items with optional filters
        app.get('/items', (c) => {
            const feedId = c.req.query('feed_id')
            const isRead = c.req.query('is_read')
            const isStarred = c.req.query('is_starred')
            const limit = parseInt(c.req.query('limit') || '50')
            const offset = parseInt(c.req.query('offset') || '0')

            let query = 'SELECT items.*, feeds.title as feed_title ' +
                'FROM items JOIN feeds ON items.feed_id = feeds.id WHERE 1=1'
            const params: (string | number)[] = []

            if (feedId) {
                query += ' AND feed_id = ?'
                params.push(parseInt(feedId))
            }

            if (isRead !== undefined) {
                query += ' AND is_read = ?'
                params.push(isRead === 'true' ? 1 : 0)
            }

            if (isStarred !== undefined) {
                query += ' AND is_starred = ?'
                params.push(isStarred === 'true' ? 1 : 0)
            }

            query += ' ORDER BY pub_date DESC, created_at DESC LIMIT ? OFFSET ?'
            params.push(limit, offset)

            const items = this.sql.exec(query, ...params).toArray()

            // Get total count
            let countQuery = 'SELECT COUNT(*) as count FROM items WHERE 1=1'
            const countParams: (string | number)[] = []

            if (feedId) {
                countQuery += ' AND feed_id = ?'
                countParams.push(parseInt(feedId))
            }
            if (isRead !== undefined) {
                countQuery += ' AND is_read = ?'
                countParams.push(isRead === 'true' ? 1 : 0)
            }
            if (isStarred !== undefined) {
                countQuery += ' AND is_starred = ?'
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
                `SELECT items.*, feeds.title as feed_title
                 FROM items
                 JOIN feeds ON items.feed_id = feeds.id
                 WHERE items.link IS NOT NULL
                 AND (${routeQuery})
                 ORDER BY pub_date DESC, created_at DESC
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

            return c.json({
                unread: unread.count,
                starred: starred.count,
                total: total.count
            })
        })

        // Mark item as read/unread
        app.patch('/items/:id', async (c) => {
            const id = parseInt(c.req.param('id'))
            const body = await c.req.json<{
                is_read?:boolean
                is_starred?:boolean
                client_updated_at?:string
            }>()

            const item = this.sql.exec(
                'SELECT * FROM items WHERE id = ?', id
            ).one() as Record<string, unknown> | null
            if (!item) {
                return c.json({ error: 'Item not found' }, 404)
            }

            if (body.client_updated_at !== undefined) {
                const serverTs = item.updated_at as string | null
                if (serverTs && serverTs > body.client_updated_at) {
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
                'SELECT * FROM items WHERE id = ?', id
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

            if (body.client_updated_at !== undefined) {
                // LWW: check if any items in scope are newer than client
                let newerItems:unknown[]
                if (body.feed_id !== undefined) {
                    newerItems = this.sql.exec(
                        'SELECT * FROM items WHERE feed_id = ?' +
                        ' AND updated_at > ?',
                        body.feed_id,
                        body.client_updated_at
                    ).toArray()
                } else {
                    newerItems = this.sql.exec(
                        'SELECT * FROM items WHERE updated_at > ?',
                        body.client_updated_at
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

            let feeds:unknown[]
            let items:unknown[]

            if (since) {
                // Incremental sync - get only changed records
                feeds = this.sql.exec(
                    'SELECT * FROM feeds ' +
                    'WHERE updated_at > ? ' +
                    'ORDER BY updated_at ASC',
                    since
                ).toArray()

                items = this.sql.exec(
                    `SELECT items.*, feeds.title as feed_title
                     FROM items
                     JOIN feeds ON items.feed_id = feeds.id
                     WHERE items.updated_at > ?
                     ORDER BY items.updated_at ASC`,
                    since
                ).toArray()
            } else {
                // Full sync - get everything
                feeds = this.sql.exec('SELECT * FROM feeds ORDER BY id ASC').toArray()
                items = this.sql.exec(
                    `SELECT items.*, feeds.title as feed_title
                     FROM items
                     JOIN feeds ON items.feed_id = feeds.id
                     ORDER BY items.id ASC`
                ).toArray()
            }

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
                syncedAt,
                latestUpdatedAt,
                isFullSync: !since
            })
        })

        return app
    }

    /**
     * Fetch and parse an RSS/Atom feed
     */
    private async fetchFeed (feed: Feed): Promise<void> {
        console.log(
            '[DO] fetchFeed:',
            feed.url
        )
        try {
            const text = await fetchFeedText(feed.url)
            console.log(
                '[DO] Feed response length:',
                text.length
            )
            const parsedFeed = this.parseFeed(text)
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

            // Insert new items
            for (const item of parsedFeed.items) {
                const guid = item.guid || item.link || item.title || ''
                if (!guid) continue

                try {
                    this.sql.exec(
                        `INSERT OR IGNORE INTO items
                            (feed_id, guid, title, link, description, content, author, pub_date)
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
                } catch (_err) {
                    // Ignore duplicate key errors
                }
            }
        } catch (err) {
            console.error(`Error fetching feed ${feed.url}:`, err)
            this.sql.exec(
                `UPDATE feeds SET
                    last_error = ?,
                    last_status = ?
                WHERE id = ?`,
                err instanceof Error ? err.message : String(err),
                err instanceof FeedFetchError ? err.status : 500,
                feed.id
            )
        }
    }

    /**
     * Parse RSS or Atom feed XML
     */
    private parseFeed (xml: string): {
        title: string | null
        description: string | null
        link: string | null
        items: Array<{
            guid: string | null
            title: string | null
            link: string | null
            description: string | null
            content: string | null
            author: string | null
            pubDate: string | null
        }>
    } {
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
            items: []
        }
    }

    private parseRss (channel: XmlObject) {
        const title = this.getText(channel, ['title'])
        const description = this.getText(channel, ['description'])
        const link = this.getText(channel, ['link'])
        const items: ReturnType<typeof this.parseFeed>['items'] = []
        const itemNodes = this.asArray(this.getChild(channel, ['item']))

        for (const itemNode of itemNodes) {
            const item = this.asObject(itemNode)
            if (!item) continue

            items.push({
                guid: this.getText(item, ['guid', 'id']) ||
                    this.getText(item, ['link']),
                title: this.getText(item, ['title', 'media:title']),
                link: this.getText(item, ['link']),
                description: this.getText(item, ['description']),
                content: this.getText(item, [
                    'content:encoded',
                    'encoded',
                    'content'
                ]),
                author: this.getText(item, [
                    'author',
                    'dc:creator',
                    'creator'
                ]),
                pubDate: this.parseDate(this.getText(item, ['pubDate']))
            })
        }

        return { title, description, link, items }
    }

    private parseAtom (feed: XmlObject) {
        const title = this.getText(feed, ['title'])
        const description = this.getText(feed, ['subtitle'])
        const link = this.getLinkHref(this.getChild(feed, ['link']))
        const items: ReturnType<typeof this.parseFeed>['items'] = []
        const entries = this.asArray(this.getChild(feed, ['entry']))

        for (const entryNode of entries) {
            const entry = this.asObject(entryNode)
            if (!entry) continue

            const author = this.asObject(this.getChild(entry, ['author']))

            items.push({
                guid: this.getText(entry, ['id']),
                title: this.getText(entry, ['title']),
                link: this.getLinkHref(this.getChild(entry, ['link'])),
                description: this.getText(entry, ['summary']),
                content: this.getText(entry, ['content']),
                author: author ? this.getText(author, ['name']) : null,
                pubDate: this.parseDate(
                    this.getText(entry, ['published']) ||
                    this.getText(entry, ['updated'])
                )
            })
        }

        return { title, description, link, items }
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

    /**
     * Alarm handler for periodic feed refresh
     */
    async alarm (): Promise<void> {
        const feeds = this.sql.exec('SELECT * FROM feeds')
            .toArray() as unknown as Feed[]

        await this.refreshFeeds(feeds)

        // Schedule next alarm in 10 minutes
        await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000)
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
