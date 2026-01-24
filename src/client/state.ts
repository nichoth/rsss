import { signal, computed, batch } from '@preact/signals'
import Route from 'route-event'
import ky, { HTTPError } from 'ky'
import Debug from '@substrate-system/debug'
const debug = Debug('rsss')

export interface User {
    did:string
    handle:string
}

export interface Feed {
    id:number
    url:string
    title:string|null
    description:string|null
    site_url:string|null
    last_fetched:string|null
    created_at:string
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
    is_read:number
    is_starred:number
    created_at:string
    feed_title?:string
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
}

export function State () {
    const onRoute = Route()

    // Route state
    const state = {
        _setRoute: onRoute.setRoute.bind(onRoute),
        route: signal(location.pathname),
        // Auth state
        user: signal<User|null>(null),
        authLoading: signal(true),
        authError: signal<string | null>(null),
        // Feeds state
        feeds: signal<Feed[]>([]),
        feedsLoading: signal(false),
        // Items state
        items: signal<Item[]>([]),
        itemsLoading: signal(false),
        itemsTotal: signal(0),
        itemsOffset: signal(0),
        // Counts
        counts: signal<CountsResponse>({ unread: 0, starred: 0, total: 0 }),
        // Selected feed filter
        selectedFeedId: signal<number | null>(null),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        // Selected item for reading
        selectedItem: signal<Item | null>(null),
        // Computed: is authenticated
        isAuthenticated: computed(() => state.user.value !== null)
    }

    // Set up route listener
    onRoute((path:string, data) => {
        state.route.value = path
        if (data.popstate) {
            window.scrollTo(data.scrollX, data.scrollY)
        } else {
            window.scrollTo(0, 0)
        }
    })

    return state
}

export type AppState = ReturnType<typeof State>

/**
 * API client for Collie endpoints
 */
const api = ky.create({
    prefixUrl: '/api',
})

/**
 * Check authentication status
 */
export async function checkAuth (state: AppState): Promise<void> {
    state.authLoading.value = true
    state.authError.value = null

    try {
        const response = await api.get('me')

        if (response.ok) {
            const data = await response.json<{
                authenticated:boolean;
                did:string;
                handle:string
            }>()
            if (data.authenticated) {
                state.user.value = { did: data.did, handle: data.handle }
            } else {
                state.user.value = null
            }
        } else {
            state.user.value = null
        }
    } catch {
        state.user.value = null
    } finally {
        state.authLoading.value = false
    }
}

/**
 * Start OAuth login flow
 */
export async function login (state:AppState, handle:string):Promise<void> {
    state.authLoading.value = true
    state.authError.value = null

    try {
        const response = await api.post('auth/login', { json: { handle } })

        if (!response.ok) {
            const error = await response.json<{ error: string }>()
            throw new Error(error.error || 'Login failed')
        }

        const data = await response.json<{ authUrl: string }>()

        // Redirect to OAuth provider
        window.location.href = data.authUrl
    } catch (err) {
        batch(() => {
            state.authError.value = err instanceof Error ?
                err.message :
                'Login failed'
            state.authLoading.value = false
        })
    }
}

/**
 * Dev mode login (for testing)
 */
export async function devLogin (state:AppState):Promise<void> {
    state.authLoading.value = true

    try {
        const response = await api.post('auth/dev-login', {
            json: { handle: 'test.bsky.social' }
        })

        if (response.ok) {
            await checkAuth(state)
        }
    } finally {
        state.authLoading.value = false
    }
}

/**
 * Logout
 */
export async function logout (state:AppState):Promise<void> {
    await api.post('auth/logout')
    batch(() => {
        state.user.value = null
        state.feeds.value = []
        state.items.value = []
    })
    window.location.href = '/login'
}

/**
 * Load feeds
 */
export async function loadFeeds (state:AppState):Promise<void> {
    state.feedsLoading.value = true

    try {
        const response = await api.get('collie/feeds')

        if (response.ok) {
            const data = await response.json<{ feeds: Feed[] }>()
            batch(() => {
                state.feeds.value = data.feeds
                state.feedsLoading.value = false
            })
        }
    } catch (_err) {
        state.feedsLoading.value = false
    }
}

/**
 * Add a new feed
 */
export async function addFeed (state: AppState, url: string): Promise<{ success: boolean; error?: string }> {
    try {
        const response = await api.post('collie/feeds', { json: { url } })

        if (response.ok) {
            await loadFeeds(state)
            await loadCounts(state)
            return { success: true }
        } else {
            const error = await response.json<{ error: string }>()
            return { success: false, error: error.error }
        }
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to add feed'
        }
    }
}

/**
 * Delete a feed
 */
export async function deleteFeed (state: AppState, feedId: number): Promise<void> {
    const response = await api.delete(`collie/feeds/${feedId}`)

    if (response.ok) {
        await loadFeeds(state)
        await loadItems(state)
        await loadCounts(state)
    }
}

/**
 * Refresh all feeds
 */
export async function refreshFeeds (state: AppState): Promise<void> {
    state.feedsLoading.value = true

    try {
        await api.post('collie/feeds/refresh')
        await loadFeeds(state)
        await loadItems(state)
        await loadCounts(state)
    } finally {
        state.feedsLoading.value = false
    }
}

/**
 * Load items with current filters
 */
export async function loadItems (state: AppState): Promise<void> {
    state.itemsLoading.value = true

    try {
        const params = new URLSearchParams()
        params.set('limit', '50')
        params.set('offset', state.itemsOffset.value.toString())

        if (state.selectedFeedId.value) {
            params.set('feed_id', state.selectedFeedId.value.toString())
        }

        if (state.showUnreadOnly.value) {
            params.set('is_read', 'false')
        }

        if (state.showStarredOnly.value) {
            params.set('is_starred', 'true')
        }

        const response = await api.get(`collie/items?${params.toString()}`)

        if (response.ok) {
            const data = await response.json<ItemsResponse>()
            state.items.value = data.items
            state.itemsTotal.value = data.total
        }
    } finally {
        state.itemsLoading.value = false
    }
}

/**
 * Load counts
 */
export async function loadCounts (state: AppState): Promise<void> {
    try {
        const response = await api.get('collie/items/count')

        if (response.ok) {
            const data = await response.json<CountsResponse>()
            state.counts.value = data
        }
    } catch (_err) {
        const err = _err as HTTPError
        // Ignore count errors
        debug('error', err)
    }
}

/**
 * Mark item as read/unread
 */
export async function toggleItemRead (
    state:AppState,
    itemId:number,
    isRead:boolean
):Promise<void> {
    const response = await api.patch(`collie/items/${itemId}`, {
        json: { is_read: isRead }
    })

    if (response.ok) {
        // Update local state
        batch(() => {
            state.items.value = state.items.value.map(item =>
                item.id === itemId ? {
                    ...item,
                    is_read: isRead ? 1 : 0
                } : item
            )

            if (state.selectedItem.value?.id === itemId) {
                state.selectedItem.value = {
                    ...state.selectedItem.value,
                    is_read: isRead ? 1 : 0
                }
            }
        })

        await loadCounts(state)
    }
}

/**
 * Toggle item starred
 */
export async function toggleItemStarred (
    state:AppState,
    itemId:number,
    isStarred:boolean
):Promise<void> {
    const response = await api.patch(`collie/items/${itemId}`, {
        json: { is_starred: isStarred }
    })

    if (response.ok) {
        // Update local state
        batch(() => {
            state.items.value = state.items.value.map(item =>
                item.id === itemId ? {
                    ...item,
                    is_starred: isStarred ? 1 : 0
                } : item
            )

            if (state.selectedItem.value?.id === itemId) {
                state.selectedItem.value = {
                    ...state.selectedItem.value,
                    is_starred: isStarred ? 1 : 0
                }
            }
        })

        await loadCounts(state)
    }
}

/**
 * Mark all items as read
 */
export async function markAllRead (state:AppState, feedId?:number):Promise<void> {
    const body = feedId ? { feed_id: feedId } : {}
    const response = await api.post('collie/items/mark-all-read', { json: body })

    if (response.ok) {
        await loadItems(state)
        await loadCounts(state)
    }
}

/**
 * Select an item for reading
 */
export async function selectItem (state:AppState, item:Item):Promise<void> {
    state.selectedItem.value = item

    // Mark as read if not already
    if (!item.is_read) {
        await toggleItemRead(state, item.id, true)
    }
}

/**
 * Clear selected item
 */
export function clearSelectedItem (state: AppState): void {
    state.selectedItem.value = null
}
