import { type Signal, signal, computed, batch, effect } from '@preact/signals'
import Route from 'route-event'
import ky from 'ky'
import Debug from '@substrate-system/debug'
import { localAdapter } from './db/local-adapter.js'
const debug = Debug('rsss:state')

const USER_STORAGE_KEY = 'rsss_user'
export const DEFAULT_PAGE_SIZE = 20

export interface User {
    did: string
    handle: string
}

export interface Feed {
    id: number
    url: string
    title: string | null
    description: string | null
    site_url: string | null
    last_fetched: string | null
    is_locally_cached: number
    created_at: string
}

export interface Item {
    id: number
    feed_id: number
    guid: string
    title: string | null
    link: string | null
    description: string | null
    content: string | null
    author: string | null
    pub_date: string | null
    is_read: number
    is_starred: number
    created_at: string
    feed_title?: string
}

export interface ItemsResponse {
    items: Item[]
    total: number
    limit: number
    offset: number
}

export interface CountsResponse {
    unread: number
    starred: number
    total: number
}

export type AppState = {
    _setRoute: (route: string) => void,
    route: Signal<string>,
    user: Signal<User | null>,
    authLoading: Signal<boolean>,
    authError: Signal<string | null>,
    isOnline: Signal<boolean>,
    feeds: Signal<Feed[]>,
    feedsLoading: Signal<boolean>,
    items: Signal<Item[]>,
    itemsLoading: Signal<boolean>,
    itemsTotal: Signal<number>,
    itemsOffset: Signal<number>,
    counts: Signal<CountsResponse>,
    showUnreadOnly: Signal<boolean>,
    showStarredOnly: Signal<boolean>,
    pageSize: Signal<number>,
    selectedFeedId: Signal<number | null>,
    isAuthenticated: Signal<boolean>
}

export function State (): AppState {
    const onRoute = Route()

    // Route state
    const state = {
        _setRoute: onRoute.setRoute.bind(onRoute),
        route: signal(location.pathname),
        // Auth state
        user: signal<User | null>(null),
        authLoading: signal(true),
        authError: signal<string | null>(null),
        isAuthenticated: computed(() => state.user.value !== null),
        // Network state
        isOnline: signal(navigator.onLine),
        // Feeds state
        feeds: signal<Feed[]>([]),
        feedsLoading: signal<boolean>(false),
        // Items state
        items: signal<Item[]>([]),
        itemsLoading: signal(false),
        itemsTotal: signal(0),
        itemsOffset: signal(0),
        counts: signal<CountsResponse>({ unread: 0, starred: 0, total: 0 }),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        pageSize: signal(DEFAULT_PAGE_SIZE),
        selectedFeedId: signal<number|null>(null),
    }

    // Listen for online/offline events
    window.addEventListener('online', () => {
        state.isOnline.value = true
        // Sync from remote when coming back online
        if (state.isAuthenticated.value) {
            State.sync(state)
        }
    })
    window.addEventListener('offline', () => {
        state.isOnline.value = false
    })

    onRoute((path:string, data) => {
        state.route.value = path.split('?').shift()
        if (data.popstate) {  // handle scroll position like a browser
            window.scrollTo(data.scrollX, data.scrollY)
        } else {
            window.scrollTo(0, 0)
        }
    })

    /**
     * Load data after authentication
     * 1. Load cached data from IndexedDB immediately
     * 2. If online, sync from remote (pull any updates)
     */
    effect(() => {
        if (!state.isAuthenticated.value) return
        // sync from remote if online (will reload data after sync)
        if (state.isOnline.value) {
            State.sync(state)
        }

        // load cached data from IndexedDB
        State.loadFeeds(state)
        State.loadItems(state)
        State.loadCounts(state)
    })

    // Check auth right away
    State.checkAuth(state)

    return state
}

/**
 * API client
 */
const api = ky.create({
    prefixUrl: '/api',
})

/**
 * Handle OAuth callback by POSTing params
 * to the server API.
 */
State.handleOAuthCallback = async function (
    state:AppState
):Promise<void> {
    const params = new URLSearchParams(
        window.location.search
    )

    const code = params.get('code')
    const nonce = params.get('state')
    const iss = params.get('iss')
    const error = params.get('error')
    const errorDescription = params.get('error_description')

    if (error) {
        state.authError.value = errorDescription || error
        state._setRoute('/login')
        return
    }

    if (!code || !nonce || !iss) {
        state.authError.value = 'Missing OAuth parameters'
        state._setRoute('/login')
        return
    }

    state.authLoading.value = true

    try {
        const res = await api.post('auth/callback', {
            json: { code, state: nonce, iss }
        })

        const data = await res.json<{
            success:boolean;
            returnTo?:string;
            error?:string;
        }>()

        if (data.success) {
            await State.checkAuth(state)
            state._setRoute(data.returnTo || '/')
        } else {
            state.authError.value = (
                data.error || 'Authentication failed'
            )
            state._setRoute('/login')
        }
    } catch (err) {
        debug('OAuth callback error:', err)
        state.authError.value = err instanceof Error ?
            err.message :
            'Authentication failed'
        state._setRoute('/login')
    } finally {
        state.authLoading.value = false
    }
}

State.showAll = function (state: AppState) {
    batch(() => {
        state.showStarredOnly.value = false
        state.itemsOffset.value = 0
    })

    State.loadItems(state)
}

State.showStarred = function (state: AppState) {
    batch(() => {
        state.showStarredOnly.value = true
        state.itemsOffset.value = 0
        State.loadItems(state)
    })

    State.loadItems(state)
}

/**
 * Check authentication status
 */
State.checkAuth = async function (state:AppState):Promise<void> {
    state.authLoading.value = true
    state.authError.value = null

    try {
        const response = await api.get('me')

        if (response.ok) {
            const data = await response.json<{
                authenticated: boolean;
                did: string;
                handle: string
            }>()
            if (data.authenticated) {
                const user = { did: data.did, handle: data.handle }
                state.user.value = user
                // Cache user for offline use
                localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
            } else {
                state.user.value = null
                localStorage.removeItem(USER_STORAGE_KEY)
            }
        } else {
            state.user.value = null
            localStorage.removeItem(USER_STORAGE_KEY)
        }
    } catch {
        // Network error - check if we're offline
        if (!navigator.onLine) {
            // Try to load cached user for offline mode
            const cachedUser = localStorage.getItem(USER_STORAGE_KEY)
            if (cachedUser) {
                try {
                    state.user.value = JSON.parse(cachedUser) as User
                    debug('Using cached user for offline mode')
                } catch {
                    state.user.value = null
                }
            }
            // Don't clear user if we're offline and have cached data
        } else {
            state.user.value = null
        }
    } finally {
        state.authLoading.value = false
    }
}

/**
 * Start OAuth login flow
 */
State.login = async function (state: AppState, handle: string): Promise<void> {
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
State.devLogin = async function (state: AppState): Promise<void> {
    state.authLoading.value = true

    try {
        const response = await api.post('auth/dev-login', {
            json: { handle: 'test.bsky.social' }
        })

        if (response.ok) {
            await State.checkAuth(state)
        }
    } finally {
        state.authLoading.value = false
    }
}

/**
 * Logout
 */
State.logout = async function (state: AppState): Promise<void> {
    try {
        await api.post('auth/logout')
    } catch {
        // Ignore logout errors (might be offline)
    }
    localStorage.removeItem(USER_STORAGE_KEY)
    batch(() => {
        state.user.value = null
        state.feeds.value = []
        state.items.value = []
    })
    state._setRoute('/login')
}

/**
 * Load feeds from local IndexedDB
 */
State.loadFeeds = async function (state: AppState): Promise<void> {
    if (!localAdapter.isAvailable()) return
    state.feedsLoading.value = true

    try {
        const feeds = await localAdapter.getFeeds()
        batch(() => {
            state.feeds.value = feeds
            state.feedsLoading.value = false
        })
    } catch (err) {
        debug('Error loading feeds:', err)
        state.feedsLoading.value = false
    }
}

/**
 * Add a new feed (requires online)
 */
State.addFeed = async function (
    state: AppState,
    url: string
): Promise<Response> {
    if (!state.isOnline.value) {
        debug('offline...')
        throw new Error('Cannot add feeds while offline')
    }

    try {
        const response = await api.post(
            'feeds',
            { json: { url } }
        )
        debug('got response...', response)

        // Server wrote the feed and fetched its items.
        // Sync to pull everything into IndexedDB, then
        // reload UI from the local store.
        await State.sync(state)

        return response
    } catch (err) {
        // Feed already exists on the server but not
        // in local state -- sync to pull it down.
        if (
            err instanceof Error &&
            'response' in err &&
            (err as { response:Response }).response
                .status === 409
        ) {
            debug('Feed already exists, syncing...')
            await State.sync(state)
            return (
                err as { response:Response }
            ).response
        }
        throw err
    }
}

/**
 * Delete a feed (requires online)
 */
State.deleteFeed = async function (
    state: AppState,
    feedId: number
): Promise<{ success: boolean; error?: string }> {
    if (!state.isOnline.value) {
        return { success: false, error: 'Cannot delete feeds while offline' }
    }

    try {
        // Delete from remote API
        await api.delete(`feeds/${feedId}`)

        // Delete from local IndexedDB
        if (localAdapter.isAvailable()) {
            await localAdapter.deleteFeed(feedId)
        }

        // Reload data to update UI
        await State.loadFeeds(state)
        await State.loadItems(state)
        await State.loadCounts(state)

        return { success: true }
    } catch (err) {
        // If the feed doesn't exist remotely (404), clean it up locally
        if (err instanceof Error && 'response' in err) {
            const response = (err as { response: Response }).response
            if (response.status === 404) {
                await localAdapter.deleteFeed(feedId)
                await State.loadFeeds(state)
                await State.loadItems(state)
                await State.loadCounts(state)
                return { success: true }
            }
        }

        return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to delete feed'
        }
    }
}

/**
 * Toggle whether a feed is locally cached
 */
State.toggleFeedCached = async function (
    state: AppState,
    feedId: number,
    isCached: boolean
): Promise<void> {
    try {
        await localAdapter.updateFeed(feedId, { is_locally_cached: isCached ? 1 : 0 })
        // Reload feeds to update UI state
        await State.loadFeeds(state)
        // Reload items because visibility might change based on cache status?
        // Or if we were filtering. But good to be safe.
        await State.loadItems(state)
    } catch (err) {
        debug('Error toggling feed cache:', err)
    }
}

/**
 * Refresh all feeds (requires online)
 */
State.refreshFeeds = async function (state: AppState): Promise<void> {
    if (!state.isOnline.value) return

    state.feedsLoading.value = true

    try {
        await api.post('feeds/refresh')
        // Sync to update local IndexedDB, then reload UI
        await State.sync(state)
    } finally {
        state.feedsLoading.value = false
    }
}

/**
 * Load items from local IndexedDB with current filters
 */
State.loadItems = async function (state:AppState):Promise<void> {
    if (!localAdapter.isAvailable()) return
    state.itemsLoading.value = true

    try {
        const options: {
            feedId?: number
            isRead?: boolean
            isStarred?: boolean
            limit?: number
            offset?: number
        } = {
            limit: state.pageSize.value,
            offset: state.itemsOffset.value
        }

        if (state.selectedFeedId.value !== null) {
            options.feedId = state.selectedFeedId.value
        }
        if (state.showUnreadOnly.value) {
            options.isRead = false
        }
        if (state.showStarredOnly.value) {
            options.isStarred = true
        }

        const data = await localAdapter.getItems(options)
        state.items.value = data.items as Item[]
        state.itemsTotal.value = data.total
    } catch (err) {
        debug('Error loading items:', err)
    } finally {
        state.itemsLoading.value = false
    }
}

/**
 * Load counts from local IndexedDB
 */
State.loadCounts = async function (state: AppState): Promise<void> {
    if (!localAdapter.isAvailable()) return

    try {
        const counts = await localAdapter.getCounts()
        state.counts.value = counts
    } catch (err) {
        debug('Error loading counts:', err)
    }
}

/**
 * Sync data from remote server to local IndexedDB
 * This pulls any changes since the last sync and updates the local cache
 */
State.sync = async function (state:AppState):Promise<void> {
    if (!state.isOnline.value) {
        debug('Cannot sync while offline')
        return
    }

    if (!localAdapter.isAvailable()) {
        debug('IndexedDB not available')
        return
    }

    try {
        debug('Syncing from remote...')
        await localAdapter.sync()
        debug('Sync complete')

        // Reload data from IndexedDB to update UI
        await State.loadFeeds(state)
        await State.loadItems(state)
        await State.loadCounts(state)
        debug('Sync complete again...', state.feeds.value)
    } catch (err) {
        debug('Sync error:', err)
        // Don't throw - just log the error and continue with cached data
    }
}

/**
 * Mark item as read/unread (requires online)
 */
State.toggleItemRead = async function (
    state:AppState,
    itemId:number,
    isRead:boolean
): Promise<void> {
    if (!state.isOnline.value) {
        debug('Cannot toggle read status while offline')
        return
    }

    try {
        const response = await api.patch(`items/${itemId}`, {
            json: { is_read: isRead }
        })

        if (response.ok) {
            // Update local UI state
            state.items.value = state.items.value.map(item =>
                item.id === itemId ? {
                    ...item,
                    is_read: isRead ? 1 : 0
                } : item
            )

            // Update local IndexedDB to keep in sync
            if (localAdapter.isAvailable()) {
                await localAdapter.updateItem(itemId, { is_read: isRead })
            }

            await State.loadCounts(state)
        }
    } catch (err) {
        debug('Error toggling read status:', err)
    }
}

/**
 * Toggle item starred (requires online)
 */
State.toggleItemStarred = async function (
    state: AppState,
    itemId: number,
    isStarred: boolean
): Promise<void> {
    if (!state.isOnline.value) {
        debug('Cannot toggle starred status while offline')
        return
    }

    try {
        const response = await api.patch(`items/${itemId}`, {
            json: { is_starred: isStarred }
        })

        if (response.ok) {
            // Update local UI state immediately for responsiveness
            batch(() => {
                state.items.value = state.items.value.map(item =>
                    item.id === itemId ? {
                        ...item,
                        is_starred: isStarred ? 1 : 0
                    } : item
                )
            })

            // Update local IndexedDB to keep in sync
            if (localAdapter.isAvailable()) {
                await localAdapter.updateItem(itemId, { is_starred: isStarred })
            }

            await State.loadCounts(state)
        }
    } catch (err) {
        debug('Error toggling starred status:', err)
    }
}

/**
 * Mark all items as read (requires online)
 */
State.markAllRead = async function (state: AppState, feedId?: number): Promise<void> {
    if (!state.isOnline.value) {
        debug('Cannot mark all read while offline')
        return
    }

    try {
        const body = feedId ? { feed_id: feedId } : {}
        const response = await api.post('items/mark-all-read', { json: body })

        if (response.ok) {
            // Update local IndexedDB to keep in sync
            if (localAdapter.isAvailable()) {
                await localAdapter.markAllRead(feedId)
            }

            await State.loadItems(state)
            await State.loadCounts(state)
        }
    } catch (err) {
        debug('Error marking all read:', err)
    }
}

/**
 * Strip protocol from a URL (e.g., "https://example.com/path" -> "example.com/path")
 */
export const stripProtocol = function (url: string): string {
    return url.replace(/^https?:\/\//, '')
}

/**
 * Convert an item's link to a route path like /post/domain.tld/feed/path
 */
export const itemToRoute = function (item: Item): string | null {
    if (!item.link) return null
    try {
        const url = new URL(item.link)
        return '/post/' + url.host + url.pathname + url.search + url.hash
    } catch {
        return null
    }
}

/**
 * Clear selected item and navigate back to list
 */
State.clearSelectedItem = function (state: AppState): void {
    state._setRoute('/')
}

/**
 * Check if a route matches an item route pattern (/domain.tld/path)
 */
export const isItemRoute = function (route:string):boolean {
    // Item routes start with / followed by a domain (contains a dot)
    // but exclude /login and other app routes
    if (
        route === '/' ||
        route.startsWith('/login') ||
        route.startsWith('/api')
    ) {
        return false
    }

    return route.includes('/post/')
}

/**
 * Find an item by its link matching the current route
 */
export const findItemByRoute = function (
    state:AppState,
    route:string
):Item|null {
    for (const item of state.items.value) {
        if (itemToRoute(item) === route) {
            return item
        }
    }
    return null
}
