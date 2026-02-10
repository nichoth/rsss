import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

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
        // Create feeds table
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS feeds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL UNIQUE,
                title TEXT,
                description TEXT,
                site_url TEXT,
                last_fetched TEXT,
                is_locally_cached INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )
        `)

        // Create items table
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feed_id INTEGER NOT NULL,
                guid TEXT NOT NULL,
                title TEXT,
                link TEXT,
                description TEXT,
                content TEXT,
                author TEXT,
                pub_date TEXT,
                is_read INTEGER DEFAULT 0,
                is_starred INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
                UNIQUE(feed_id, guid)
            )
        `)

        // Create indexes (excluding updated_at - added after migration)
        this.sql.exec(`
            CREATE INDEX IF NOT EXISTS idx_items_feed_id ON items(feed_id);
            CREATE INDEX IF NOT EXISTS idx_items_is_read ON items(is_read);
            CREATE INDEX IF NOT EXISTS idx_items_is_starred ON items(is_starred);
            CREATE INDEX IF NOT EXISTS idx_items_pub_date ON items(pub_date DESC);
        `)

        // Migration: Add updated_at column to existing tables if missing
        this.migrateAddUpdatedAt()
        this.migrateAddIsLocallyCached()

        // Create indexes on updated_at (after migration ensures column exists)
        this.sql.exec(`
            CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at);
            CREATE INDEX IF NOT EXISTS idx_feeds_updated_at ON feeds(updated_at);
        `)

        // Create triggers to auto-update updated_at
        // Using WHEN clause to prevent infinite recursion
        this.sql.exec(`
            CREATE TRIGGER IF NOT EXISTS feeds_updated_at
            AFTER UPDATE ON feeds
            FOR EACH ROW
            WHEN OLD.updated_at = NEW.updated_at OR NEW.updated_at IS NULL
            BEGIN
                UPDATE feeds SET updated_at = datetime('now') WHERE id = NEW.id;
            END
        `)

        this.sql.exec(`
            CREATE TRIGGER IF NOT EXISTS items_updated_at
            AFTER UPDATE ON items
            FOR EACH ROW
            WHEN OLD.updated_at = NEW.updated_at OR NEW.updated_at IS NULL
            BEGIN
                UPDATE items SET updated_at = datetime('now') WHERE id = NEW.id;
            END
        `)
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
            const body = await c.req.json<{ url: string }>()
            if (!body.url) {
                return c.json({ error: 'URL is required' }, 400)
            }

            try {
                // Check if feed already exists
                const existing = this.sql.exec(
                    'SELECT id FROM feeds WHERE url = ?',
                    body.url
                ).toArray()

                if (existing.length > 0) {
                    return c.json({ error: 'Feed already exists' }, 409)
                }

                // Insert the feed
                this.sql.exec(
                    'INSERT INTO feeds (url) VALUES (?)',
                    body.url
                )

                const feed = this.sql.exec(
                    'SELECT * FROM feeds WHERE url = ?',
                    body.url
                ).one()

                // Fetch feed content before responding so client sees
                // items immediately
                await this.fetchFeed(feed as unknown as Feed)

                // Return updated feed with title/description from fetch
                const updatedFeed = this.sql.exec(
                    'SELECT * FROM feeds WHERE url = ?',
                    body.url
                ).one()

                return c.json({ feed: updatedFeed }, 201)
            } catch (_err) {
                const err = _err as Error
                console.log('**error**', err.message)
                return c.json({ error: 'Failed to add feed' }, 500)
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
        app.delete('/feeds/:id', (c) => {
            const id = parseInt(c.req.param('id'))

            const feeds = this.sql.exec('SELECT id FROM feeds WHERE id = ?', id).toArray()
            if (feeds.length === 0) {
                return c.json({ error: 'Feed not found' }, 404)
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

            await this.fetchFeed(feed)
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
            const body = await c.req.json<{ is_read?: boolean; is_starred?: boolean }>()

            const item = this.sql.exec('SELECT id FROM items WHERE id = ?', id).one()
            if (!item) {
                return c.json({ error: 'Item not found' }, 404)
            }

            if (body.is_read !== undefined) {
                this.sql.exec('UPDATE items SET is_read = ? WHERE id = ?', body.is_read ? 1 : 0, id)
            }

            if (body.is_starred !== undefined) {
                this.sql.exec('UPDATE items SET is_starred = ? WHERE id = ?', body.is_starred ? 1 : 0, id)
            }

            const updated = this.sql.exec('SELECT * FROM items WHERE id = ?', id).one()
            return c.json({ item: updated })
        })

        // Mark all items as read
        app.post('/items/mark-all-read', async (c) => {
            const body = await c.req.json<{ feed_id?: number }>().catch(() => ({ feed_id: undefined }))

            if (body.feed_id !== undefined) {
                this.sql.exec('UPDATE items SET is_read = 1 WHERE feed_id = ?', body.feed_id)
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
        try {
            const response = await fetch(feed.url, {
                headers: {
                    'User-Agent': 'RSSS/1.0 RSS Reader'
                }
            })

            if (!response.ok) {
                console.error(`Failed to fetch feed ${feed.url}: ${response.status}`)
                return
            }

            const text = await response.text()
            const parsedFeed = this.parseFeed(text)

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
