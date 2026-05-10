/**
 * Shared types for database operations
 */

import type { FullContentStatus } from '../../shared/schema.js'

export type { FullContentStatus }

export interface Feed {
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

export interface Item {
    id:number
    feed_id:number
    guid:string
    title:string|null
    link:string|null
    description:string|null
    content:string|null
    author:string|null
    pub_date:string|null
    thumbnail_url:string|null
    og_image_url?:string|null
    blurhash?:string|null
    image_width?:number|null
    image_height?:number|null
    is_read:number
    is_starred:number
    created_at:string
    updated_at:string
    feed_title?:string
    full_content?:string|null
    full_content_fetched_at?:string|null
    full_content_status?:FullContentStatus|null
}

export interface ItemsResponse {
    items:Item[]
    total:number
    limit:number
    offset:number
}

export interface CountsResponse {
    unread:number
    starred:number
    total:number
    perFeed:Record<string, number>
}

export interface FeedsResponse {
    feeds:Feed[]
    feedUpdateStatus?:'synced'|'updates'
    feedsWithUpdates?:string[]
}

/**
 * Response shape for `GET /api/feed-status`. Drives the header
 * "n updates / up to date" indicator. See
 * `specs/008-fix-up-to-date-dot/contracts/feed-status-endpoint.md`.
 */
export interface FeedStatusResponse {
    feedUpdateCounts:Record<string, number>
    totalPending:number
}

/**
 * Database adapter interface
 */
export interface DbAdapter {
    getFeeds():Promise<FeedsResponse>
    addFeed(url:string):Promise<Feed>
    deleteFeed(id:number):Promise<void>

    getItems(options?:{
        feedId?:number
        isRead?:boolean
        isStarred?:boolean
        limit?:number
        offset?:number
    }):Promise<ItemsResponse>
    getItemByRoute(itemRoute:string):Promise<Item|null>
    getCounts():Promise<CountsResponse>
    updateItem(
        id:number,
        updates:{ is_read?:boolean; is_starred?:boolean }
    ):Promise<void>
    markAllRead(feedId?:number):Promise<void>
}
