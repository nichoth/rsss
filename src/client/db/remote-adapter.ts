/**
 * Remote API adapter
 * Uses the Cloudflare backend via ky HTTP client
 */

import ky, { HTTPError } from 'ky'
import type {
    DbAdapter,
    Feed,
    FeedsResponse,
    Item,
    ItemsResponse,
    CountsResponse
} from './types.js'

export class FetchFullThrottledError extends Error {
    retryAfterSeconds:number

    constructor (retryAfterSeconds:number) {
        super('fetch_full_throttled')
        this.name = 'FetchFullThrottledError'
        this.retryAfterSeconds = retryAfterSeconds
    }
}

function csrfToken ():string|undefined {
    return document.cookie.split(';')
        .map(part => part.trim())
        .find(part => part.startsWith('csrf_token='))
        ?.slice('csrf_token='.length)
}

const api = ky.create({
    prefixUrl: '/api',
    hooks: {
        beforeRequest: [
            request => {
                const token = csrfToken()
                if (token) request.headers.set('X-CSRF-Token', token)
            }
        ]
    }
})

export const remoteAdapter:DbAdapter = {
    async getFeeds ():Promise<FeedsResponse> {
        const response = await api.get('feeds')
        // Indicator state (`feedUpdateCounts`) is owned by
        // `GET /api/feed-status`; we accept and discard the
        // legacy `feedUpdateCounts` field for one deploy window
        // so older server bundles stay compatible.
        const data = await response.json<{
            feeds:Feed[]
            feedUpdateStatus?:string
            feedsWithUpdates?:string[]
        }>()
        return {
            feeds: data.feeds,
            feedUpdateStatus: data.feedUpdateStatus === 'updates' ?
                'updates' :
                'synced',
            feedsWithUpdates: data.feedsWithUpdates ?? []
        }
    },

    async addFeed (url:string):Promise<Feed> {
        const response = await api.post(
            'feeds',
            { json: { url } }
        )
        const data = await response.json<{ feed:Feed }>()
        return data.feed
    },

    async deleteFeed (id:number):Promise<void> {
        await api.delete(`feeds/${id}`)
    },

    async getItems (options = {}):Promise<ItemsResponse> {
        const {
            feedId,
            isRead,
            isStarred,
            limit = 50,
            offset = 0
        } = options

        const params = new URLSearchParams()
        params.set('limit', limit.toString())
        params.set('offset', offset.toString())

        if (feedId !== undefined) {
            params.set('feed_id', feedId.toString())
        }
        if (isRead !== undefined) {
            params.set('is_read', isRead.toString())
        }
        if (isStarred !== undefined) {
            params.set('is_starred', isStarred.toString())
        }

        const response = await api.get(
            `items?${params.toString()}`
        )
        return response.json<ItemsResponse>()
    },

    async getItemByRoute (itemRoute:string):Promise<Item|null> {
        try {
            const response = await api.get('items/by-route', {
                searchParams: { route: itemRoute }
            })

            const data = await response.json<{
                item:Item
            }>()
            return data.item
        } catch (err) {
            if (
                err instanceof Error &&
                'response' in err &&
                (err as { response?:Response }).response?.status === 404
            ) {
                return null
            }

            throw err
        }
    },

    async getCounts ():Promise<CountsResponse> {
        const response = await api.get('items/count')
        return response.json<CountsResponse>()
    },

    async updateItem (
        id:number,
        updates:{ is_read?:boolean; is_starred?:boolean }
    ):Promise<void> {
        await api.patch(`items/${id}`, { json: updates })
    },

    async markAllRead (feedId?:number):Promise<void> {
        const body = feedId !== undefined ?
            { feed_id: feedId } :
            {}
        await api.post('items/mark-all-read', { json: body })
    }
}

export async function fetchFullArticle (
    itemId:number,
    opts:{ force?:boolean } = {}
):Promise<{ item:Item }> {
    try {
        const response = await api.post(`items/${itemId}/fetch-full`, {
            json: { force: opts.force === true }
        })
        return response.json<{ item:Item }>()
    } catch (err) {
        if (err instanceof HTTPError && err.response.status === 429) {
            const header = err.response.headers.get('Retry-After')
            const seconds = header ? Number.parseInt(header, 10) : 5
            throw new FetchFullThrottledError(
                Number.isFinite(seconds) && seconds > 0 ? seconds : 5
            )
        }
        throw err
    }
}
