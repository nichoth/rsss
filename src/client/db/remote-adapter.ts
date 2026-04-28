/**
 * Remote API adapter
 * Uses the Cloudflare backend via ky HTTP client
 */

import ky from 'ky'
import type {
    DbAdapter,
    Feed,
    Item,
    ItemsResponse,
    CountsResponse
} from './types.js'

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
    async getFeeds ():Promise<Feed[]> {
        const response = await api.get('feeds')
        const data = await response.json<{ feeds:Feed[] }>()
        return data.feeds
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
