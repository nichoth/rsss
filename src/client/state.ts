import { type Signal, signal, computed, batch, effect } from '@preact/signals'
import Route from 'route-event'
import ky from 'ky'
import Debug from '@substrate-system/debug'
import { localAdapter } from './db/local-adapter.js'
import { remoteAdapter } from './db/remote-adapter.js'
const debug = Debug('rsss')

const USER_STORAGE_KEY = 'rsss_user'

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
    is_locally_cached:number
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

export type AppState = {
    _setRoute:(route:string)=>void,
    route:Signal<string>,
    user:Signal<User|null>,
    authLoading:Signal<boolean>,
    authError:Signal<string|null>,
    isOnline:Signal<boolean>,
    feeds:Signal<Feed[]>,
    feedsLoading:Signal<boolean>,
    items:Signal<Item[]>,
    itemsLoading:Signal<boolean>,
    itemsTotal:Signal<number>,
    itemsOffset:Signal<number>,
    counts:Signal<CountsResponse>,
    selectedFeedId:Signal<number|null>,
    showUnreadOnly:Signal<boolean>,
    showStarredOnly:Signal<boolean>,
    isAuthenticated:Signal<boolean>
}

export function State ():AppState {
    const onRoute = Route()

    // Route state
    const state = {
        _setRoute: onRoute.setRoute.bind(onRoute),
        route: signal(location.pathname),
        // Auth state
        user: signal<User | null>(null),
        authLoading: signal(true),
        authError: signal<string | null>(null),
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
        // Selected feed filter
        selectedFeedId: signal<number | null>(null),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        // Selected item for reading (derived from route)
        selectedItem: computed(() => {
            if (!State.isItemRoute(state.route.value)) return null
            return State.findItemByRoute(state, state.route.value)
        }),
        // Computed: is authenticated
        isAuthenticated: computed(() => state.user.value !== null)
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

    onRoute((path: string, data) => {
        state.route.value = path
        // handle scroll position like a browser
        if (data.popstate) {
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

        // load cached data from IndexedDB
        State.loadFeeds(state)
        State.loadItems(state)
        State.loadCounts(state)

        // sync from remote if online (will reload data after sync)
        if (state.isOnline.value) {
            State.sync(state)
        }
    })

    // Side-effect: mark as read when an item is "selected" via URL
    effect(() => {
        const item = state.selectedItem.value
        if (item && !item.is_read && state.isOnline.value) {
            State.toggleItemRead(state, item.id, true)
        }
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

State.showAll = function (state: AppState) {
    batch(() => {
        state.showStarredOnly.value = false
        state.selectedFeedId.value = null
        state.itemsOffset.value = 0
    })

    State.loadItems(state)
}

State.showStarred = function (state: AppState) {
    batch(() => {
        state.showStarredOnly.value = true
        state.selectedFeedId.value = null
        state.itemsOffset.value = 0
        State.loadItems(state)
    })

    State.loadItems(state)
}

/**
 * Check authentication status
 */
State.checkAuth = async function (state: AppState): Promise<void> {
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
    window.location.href = '/login'
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
): Promise<{ success: boolean; error?: string }> {
    if (!state.isOnline.value) {
        return { success: false, error: 'Cannot add feeds while offline' }
    }

    try {
        const response = await api.post('feeds', { json: { url } })

        if (response.ok) {
            // Sync to update local IndexedDB, then reload UI
            await State.sync(state)
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
 * Delete a feed (requires online)
 */
State.deleteFeed = async function (state: AppState, feedId: number): Promise<{ success: boolean; error?: string }> {
    if (!state.isOnline.value) {
        return { success: false, error: 'Cannot delete feeds while offline' }
    }

    try {
        const response = await api.delete(`feeds/${feedId}`)

        if (response.ok) {
            // Sync to update local IndexedDB, then reload UI
            await State.sync(state)
            return { success: true }
        }
        return { success: false, error: 'Failed to delete feed' }
    } catch (err) {
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
    state:AppState,
    feedId:number,
    isCached:boolean
):Promise<void> {
    if (!state.isOnline.value) return

    try {
        await api.patch(`feeds/${feedId}`, { json: { is_locally_cached: isCached } })
        // Sync to update local Feed object, then reload items
        await State.sync(state)
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
State.loadItems = async function (state: AppState): Promise<void> {
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
            limit: 50,
            offset: state.itemsOffset.value
        }

        if (state.showUnreadOnly.value) {
            options.isRead = false
        }
        if (state.showStarredOnly.value) {
            options.isStarred = true
        }

        if (state.selectedFeedId.value) {
            options.feedId = state.selectedFeedId.value
            // If the feed is NOT locally cached, use remote adapter
            const feed = state.feeds.value.find(f => f.id === state.selectedFeedId.value)
            if (feed && feed.is_locally_cached === 0 && state.isOnline.value) {
                const data = await remoteAdapter.getItems(options)
                state.items.value = data.items as Item[]
                state.itemsTotal.value = data.total
                return
            }
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
State.sync = async function (state: AppState): Promise<void> {
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
    } catch (err) {
        debug('Sync error:', err)
        // Don't throw - just log the error and continue with cached data
    }
}

/**
 * Mark item as read/unread (requires online)
 */
State.toggleItemRead = async function (
    state: AppState,
    itemId: number,
    isRead: boolean
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
            // Update local UI state immediately for responsiveness
            batch(() => {
                state.items.value = state.items.value.map(item =>
                    item.id === itemId ? {
                        ...item,
                        is_read: isRead ? 1 : 0
                    } : item
                )
            })

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
 * Convert an item's link to a route path like /domain.tld/path
 */
State.itemToRoute = function (item: Item): string | null {
    if (!item.link) return null
    try {
        const url = new URL(item.link)
        return '/' + url.host + url.pathname + url.search + url.hash
    } catch {
        return null
    }
}

/**
 * Clear selected item and navigate back to list
 */
State.clearSelectedItem = function (state:AppState):void {
    state._setRoute('/')
}

/**
 * Check if a route matches an item route pattern (/domain.tld/path)
 */
State.isItemRoute = function (route:string):boolean {
    // Item routes start with / followed by a domain (contains a dot)
    // but exclude /login and other app routes
    if (route === '/' || route.startsWith('/login') || route.startsWith('/api')) {
        return false
    }

    return route.includes('/feed/')
}

/**
 * Find an item by its link matching the current route
 */
State.findItemByRoute = function (state: AppState, route: string): Item | null {
    for (const item of state.items.value) {
        if (State.itemToRoute(item) === route) {
            return item
        }
    }
    return null
}
