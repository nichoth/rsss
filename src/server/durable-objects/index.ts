import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
    TABLES_SQL,
    INDEXES_SQL,
    TRIGGERS_SQL,
    DEAD_LETTER_OUTBOX_SQL
} from '../../shared/schema.js'
import type { FeedFetchError } from '../feed-fetch.js'
import {
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
    created_at:string
    updated_at:string
    is_locally_cached:number
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

        // 2. Server-only migrations: backfill updated_at and is_locally_cached
        // on rows that existed before those columns were added.
        // Must run after table creation but before updated_at indexes.
        this.migrateAddUpdatedAt()
        this.migrateAddIsLocallyCached()

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

    /**
     * Migration: Add is_locally_cached column to feeds table
     */
    private migrateAddIsLocallyCached () {
        const columns = this.sql.exec('PRAGMA table_info(feeds)').toArray()
        const hasColumn = columns.some((col: unknown) =>
            (col as { name: string }).name === 'is_locally_cached'
        )
        if (!hasColumn) {
            this.sql.exec('ALTER TABLE feeds ADD COLUMN is_locally_cached INTEGER DEFAULT 1')
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

                // Fetch feed content before responding
                // so client sees items immediately
                await this.fetchFeed(
                    feed as unknown as Feed
                )

                // Count items after fetch
                const itemCount = this.sql.exec(
                    'SELECT COUNT(*) as count' +
                    ' FROM items WHERE feed_id = ?',
                    (feed as unknown as Feed).id
                ).one()
                console.log(
                    '[DO] Items after fetch:',
                    JSON.stringify(itemCount)
                )

                // Return updated feed with title/description
                const updatedFeed = this.sql.exec(
                    'SELECT * FROM feeds WHERE url = ?',
                    body.url
                ).one()

                return c.json(
                    { feed: updatedFeed },
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

        // Update a feed (e.g. toggle caching)
        app.patch('/feeds/:id', async (c) => {
            const id = parseInt(c.req.param('id'))
            const body = await c.req.json<{ is_locally_cached?: boolean }>()

            const feed = this.sql.exec('SELECT id FROM feeds WHERE id = ?', id).one()
            if (!feed) {
                return c.json({ error: 'Feed not found' }, 404)
            }

            if (body.is_locally_cached !== undefined) {
                this.sql.exec(
                    'UPDATE feeds SET is_locally_cached = ? WHERE id = ?',
                    body.is_locally_cached ? 1 : 0,
                    id
                )
            }

            const updated = this.sql.exec('SELECT * FROM feeds WHERE id = ?', id).one()
            return c.json({ feed: updated })
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

            const routeCandidates = this.itemRouteCandidates(route)
            if (routeCandidates.length === 0) {
                return c.json(
                    { error: 'Route is required' },
                    400
                )
            }

            const routeQuery = routeCandidates
                .map(() => "items.link LIKE ? ESCAPE '\\'")
                .join(' OR ')
            const params = routeCandidates.map((candidate) => {
                return `%${this.escapeLikePattern(candidate)}%`
            })

            const item = this.sql.exec(
                `SELECT items.*, feeds.title as feed_title
                 FROM items
                 JOIN feeds ON items.feed_id = feeds.id
                 WHERE items.link IS NOT NULL
                 AND (${routeQuery})
                 ORDER BY pub_date DESC, created_at DESC
                 LIMIT 1`,
                ...params
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

    private itemRouteCandidates (route:string):string[] {
        const normalizedRoute = route
            .trim()
            .replace(/^\/post\//, '')
            .replace(/^\/+/, '')

        if (!normalizedRoute) return []

        const candidates = new Set<string>()
        candidates.add(normalizedRoute)

        try {
            candidates.add(decodeURIComponent(normalizedRoute))
        } catch {
            // Ignore malformed URI sequences
        }

        return Array.from(candidates)
    }

    private escapeLikePattern (value:string):string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_')
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
                        last_fetched = datetime('now')
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
        const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"')

        if (isAtom) {
            return this.parseAtom(xml)
        } else {
            return this.parseRss(xml)
        }
    }

    private parseRss (xml: string) {
        const getTagContent = (str: string, tag: string): string | null => {
            // Handle CDATA
            const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i')
            const cdataMatch = str.match(cdataRegex)
            if (cdataMatch) return cdataMatch[1].trim()

            const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
            const match = str.match(regex)
            return match ? this.decodeHtmlEntities(match[1].trim()) : null
        }

        // const getAttr = (str: string, tag: string, attr: string): string | null => {
        //     const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["'][^>]*>`, 'i')
        //     const match = str.match(regex)
        //     return match ? match[1] : null
        // }

        // Get channel info
        const channelMatch = xml.match(/<channel>([\s\S]*?)<item/i)
        const channel = channelMatch ? channelMatch[1] : ''

        const title = getTagContent(channel, 'title')
        const description = getTagContent(channel, 'description')
        const link = getTagContent(channel, 'link')

        // Get items
        const items: ReturnType<typeof this.parseFeed>['items'] = []
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi
        let itemMatch

        while ((itemMatch = itemRegex.exec(xml)) !== null) {
            const itemXml = itemMatch[1]
            items.push({
                guid: getTagContent(itemXml, 'guid') || getTagContent(itemXml, 'link'),
                title: getTagContent(itemXml, 'title'),
                link: getTagContent(itemXml, 'link'),
                description: getTagContent(itemXml, 'description'),
                content: getTagContent(itemXml, 'content:encoded') || getTagContent(itemXml, 'content'),
                author: getTagContent(itemXml, 'author') || getTagContent(itemXml, 'dc:creator'),
                pubDate: this.parseDate(getTagContent(itemXml, 'pubDate'))
            })
        }

        return { title, description, link, items }
    }

    private parseAtom (xml: string) {
        const getTagContent = (str: string, tag: string): string | null => {
            // Handle CDATA
            const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i')
            const cdataMatch = str.match(cdataRegex)
            if (cdataMatch) return cdataMatch[1].trim()

            const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
            const match = str.match(regex)
            return match ? this.decodeHtmlEntities(match[1].trim()) : null
        }

        const getLinkHref = (str: string): string | null => {
            // Look for rel="alternate" or no rel attribute
            const alternateMatch = str.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']*)["'][^>]*>/i)
            if (alternateMatch) return alternateMatch[1]

            const hrefMatch = str.match(/<link[^>]*href=["']([^"']*)["'][^>]*>/i)
            return hrefMatch ? hrefMatch[1] : null
        }

        // Get feed info (before first entry)
        const feedMatch = xml.match(/<feed[^>]*>([\s\S]*?)<entry/i)
        const feedInfo = feedMatch ? feedMatch[1] : ''

        const title = getTagContent(feedInfo, 'title')
        const description = getTagContent(feedInfo, 'subtitle')
        const link = getLinkHref(feedInfo)

        // Get entries
        const items: ReturnType<typeof this.parseFeed>['items'] = []
        const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi
        let entryMatch

        while ((entryMatch = entryRegex.exec(xml)) !== null) {
            const entryXml = entryMatch[1]
            items.push({
                guid: getTagContent(entryXml, 'id'),
                title: getTagContent(entryXml, 'title'),
                link: getLinkHref(entryXml),
                description: getTagContent(entryXml, 'summary'),
                content: getTagContent(entryXml, 'content'),
                author: getTagContent(entryXml, 'name'), // Inside <author>
                pubDate: this.parseDate(getTagContent(entryXml, 'published') || getTagContent(entryXml, 'updated'))
            })
        }

        return { title, description, link, items }
    }

    private decodeHtmlEntities (str: string): string {
        return str
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
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
        const feeds = this.sql.exec('SELECT * FROM feeds').toArray() as unknown as Feed[]

        await Promise.all(feeds.map(feed => this.fetchFeed(feed)))

        // Schedule next alarm in 10 minutes
        this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000)
    }
}
