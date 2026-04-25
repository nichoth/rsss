import {
    type Signal,
    signal,
    computed,
    batch,
    effect
} from '@preact/signals'
import Route from 'route-event'
import ky from 'ky'
import Debug from '@substrate-system/debug'
import { getAdapter, getLocalDb } from './db/index.js'
import { pullSync, SyncBillingError } from './db/pull-sync.js'
import {
    pushSync,
    getOutboxCount,
    PushSyncBillingError
} from './db/push-sync.js'
import {
    isLocalFirstActive,
    updateOnlineStatus,
    setSyncOffline
} from './db/sync-status.js'
import {
    type BillingStatus,
    setBillingStatus,
    setBillingError,
    setCheckoutInProgress,
    resetBilling
} from './billing-status.js'
const debug = Debug('rsss:state')

const USER_STORAGE_KEY = 'rsss_user'
const CHECKOUT_EMAIL_KEY = 'rsss_checkout_email'
export const DEFAULT_PAGE_SIZE = 20

/**
 * Stash the email the user entered on /signup so the
 * /payment-success page can pass it back to the server when
 * confirming or signalling failure.
 */
function saveCheckoutEmail (email:string):void {
    try {
        localStorage.setItem(CHECKOUT_EMAIL_KEY, email)
    } catch {
        // Ignore quota / private-mode errors.
    }
}

function readCheckoutEmail ():string|null {
    try {
        return localStorage.getItem(CHECKOUT_EMAIL_KEY)
    } catch {
        return null
    }
}

function clearCheckoutEmail ():void {
    try {
        localStorage.removeItem(CHECKOUT_EMAIL_KEY)
    } catch {
        // Ignore.
    }
}

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

export type { BillingStatus }

export type AppState = {
    _setRoute:(route:string) => void,
    route:Signal<string>,
    routeItem:Signal<Item|null>,
    routeItemLoading:Signal<boolean>,
    user:Signal<User|null>,
    authLoading:Signal<boolean>,
    authError:Signal<string|null>,
    feeds:Signal<Feed[]>,
    feedsLoading:Signal<boolean>,
    items:Signal<Item[]>,
    itemsLoading:Signal<boolean>,
    itemsTotal:Signal<number>,
    itemsOffset:Signal<number>,
    counts:Signal<CountsResponse>,
    showUnreadOnly:Signal<boolean>,
    showStarredOnly:Signal<boolean>,
    pageSize:Signal<number>,
    selectedFeedId:Signal<number|null>,
    isAuthenticated:Signal<boolean>
}

export function State ():AppState {
    const onRoute = Route()

    const state = {
        _setRoute: onRoute.setRoute.bind(onRoute),
        route: signal(location.pathname),
        routeItem: signal<Item|null>(null),
        routeItemLoading: signal(false),
        user: signal<User|null>(null),
        authLoading: signal(true),
        authError: signal<string|null>(null),
        isAuthenticated: computed(
            () => state.user.value !== null
        ),
        feeds: signal<Feed[]>([]),
        feedsLoading: signal<boolean>(false),
        items: signal<Item[]>([]),
        itemsLoading: signal(false),
        itemsTotal: signal(0),
        itemsOffset: signal(0),
        counts: signal<CountsResponse>(
            { unread: 0, starred: 0, total: 0 }
        ),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        pageSize: signal(DEFAULT_PAGE_SIZE),
        selectedFeedId: signal<number|null>(null),
    }

    onRoute((path:string, data) => {
        state.route.value = path.split('?').shift()
        if (data.popstate) {
            window.scrollTo(data.scrollX, data.scrollY)
        } else {
            window.scrollTo(0, 0)
        }
    })

    let routeItemRequest:string|null = null

    effect(() => {
        const route = state.route.value
        const itemFromList = findItemByRoute(state, route)

        if (!isItemRoute(route)) {
            routeItemRequest = null
            batch(() => {
                state.routeItem.value = null
                state.routeItemLoading.value = false
            })
            return
        }

        if (itemFromList) {
            routeItemRequest = null
            batch(() => {
                state.routeItem.value = itemFromList
                state.routeItemLoading.value = false
            })

            if (!itemFromList.is_read) {
                State.toggleItemRead(
                    state,
                    itemFromList.id,
                    true
                )
            }
            return
        }

        if (!state.isAuthenticated.value) {
            batch(() => {
                state.routeItem.value = null
                state.routeItemLoading.value = false
            })
            return
        }

        if (routeItemRequest === route) return
        routeItemRequest = route
        state.routeItemLoading.value = true

        State.loadItemByRoute(state, route)
            .then((item) => {
                if (state.route.value !== route) return

                batch(() => {
                    state.routeItem.value = item
                    state.routeItemLoading.value = false
                })

                if (item && !item.is_read) {
                    State.toggleItemRead(
                        state,
                        item.id,
                        true
                    )
                }
            })
            .catch((err) => {
                debug('Error loading route item:', err)
                if (state.route.value !== route) return
                batch(() => {
                    state.routeItem.value = null
                    state.routeItemLoading.value = false
                })
            })
            .finally(() => {
                if (routeItemRequest === route) {
                    routeItemRequest = null
                }
            })
    })

    /**
     * Load data after authentication; run pullSync when
     * local-first adapter is active. Billing status is loaded
     * in parallel so the UI can show free-vs-paid state quickly.
     */
    effect(() => {
        if (!state.isAuthenticated.value) return
        const did = state.user.value?.did

        State.loadBillingStatus(state)

        getAdapter(did).then(() => {
            const db = getLocalDb(did)
            if (db) {
                isLocalFirstActive.value = true
                pullSync(db).catch((err) => {
                    if (err instanceof SyncBillingError) {
                        State.loadBillingStatus(state)
                        return
                    }
                    debug('pullSync error:', err)
                }).then(() => {
                    pushSync(db).catch((err) => {
                        if (err instanceof PushSyncBillingError) {
                            State.loadBillingStatus(state)
                            return
                        }
                        debug('pushSync error:', err)
                    })
                    State.loadFeeds(state)
                    State.loadItems(state)
                    State.loadCounts(state)
                })
            } else {
                isLocalFirstActive.value = false
                State.loadFeeds(state)
                State.loadItems(state)
                State.loadCounts(state)
            }
        })
    })

    window.addEventListener('online', () => {
        updateOnlineStatus()
        const did = state.user.value?.did
        const db = getLocalDb(did)
        if (db) {
            pullSync(db).catch((err) => {
                if (err instanceof SyncBillingError) {
                    State.loadBillingStatus(state)
                    return
                }
                debug('pullSync online error:', err)
            }).then(() => {
                pushSync(db).catch((err) => {
                    if (err instanceof PushSyncBillingError) {
                        State.loadBillingStatus(state)
                        return
                    }
                    debug('pushSync online error:', err)
                })
            })
        }
    })

    window.addEventListener('offline', () => {
        const did = state.user.value?.did
        const db = getLocalDb(did)
        const pending = db ? getOutboxCount(db) : 0
        setSyncOffline(pending)
    })

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

State.showAll = function (state:AppState) {
    batch(() => {
        state.showStarredOnly.value = false
        state.itemsOffset.value = 0
    })

    State.loadItems(state)
}

State.showStarred = function (state:AppState) {
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
State.checkAuth = async function (
    state:AppState
):Promise<void> {
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
                const user = {
                    did: data.did,
                    handle: data.handle
                }
                state.user.value = user
                localStorage.setItem(
                    USER_STORAGE_KEY,
                    JSON.stringify(user)
                )
            } else {
                state.user.value = null
                localStorage.removeItem(USER_STORAGE_KEY)
            }
        } else {
            state.user.value = null
            localStorage.removeItem(USER_STORAGE_KEY)
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
State.login = async function (
    state:AppState,
    handle:string
):Promise<void> {
    state.authLoading.value = true
    state.authError.value = null

    try {
        const response = await api.post(
            'auth/login',
            { json: { handle } }
        )

        if (!response.ok) {
            const error = await response.json<{
                error:string
            }>()
            throw new Error(
                error.error || 'Login failed'
            )
        }

        const data = await response.json<{
            authUrl:string
        }>()

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
State.devLogin = async function (
    state:AppState
):Promise<void> {
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
 * Load current billing/entitlement status from the server.
 * Called after auth lands and after returning from checkout.
 */
State.loadBillingStatus = async function (
    _state:AppState
):Promise<BillingStatus|null> {
    try {
        const res = await api.get('billing/status', {
            throwHttpErrors: false
        })
        if (!res.ok) {
            setBillingError(`status_${res.status}`)
            return null
        }
        const data = await res.json<BillingStatus>()
        setBillingStatus(data)
        setBillingError(null)
        return data
    } catch (err) {
        debug('loadBillingStatus error:', err)
        setBillingError(err instanceof Error ?
            err.message :
            'Failed to load billing status')
        return null
    }
}

/**
 * Start checkout. In live mode this navigates the browser to
 * the Autumn-hosted checkout page; in dev mode the server
 * skips checkout and marks the user entitled in one round-trip.
 *
 * `email` is collected on the /signup form so the server can
 * notify the user about success or failure even when Stripe
 * never sees a confirmed payment.
 */
State.startCheckout = async function (
    state:AppState,
    planId:string,
    email?:string
):Promise<void> {
    batch(() => {
        setCheckoutInProgress(true)
        setBillingError(null)
    })

    if (email) saveCheckoutEmail(email)

    try {
        const res = await api.post('billing/checkout', {
            json: email ? { planId, email } : { planId },
            throwHttpErrors: false
        })
        if (!res.ok) {
            const body = await res.json<{
                error?:string
            }>().catch(() => ({} as { error?:string }))
            throw new Error(
                body.error || `checkout_${res.status}`
            )
        }
        const data = await res.json<{
            paymentUrl:string|null
            status:string
            planId:string
        }>()

        if (data.paymentUrl) {
            window.location.assign(data.paymentUrl)
            return
        }

        // Dev-mode: server already entitled the user.
        setCheckoutInProgress(false)
        await State.loadBillingStatus(state)
        state._setRoute('/')
    } catch (err) {
        batch(() => {
            setCheckoutInProgress(false)
            setBillingError(err instanceof Error ?
                err.message :
                'Checkout failed')
        })
    }
}

/**
 * Finalize checkout after returning from Autumn. Retries on 402
 * because Autumn's view of the subscription can lag the redirect
 * by a couple of seconds.
 */
State.finalizeCheckout = async function (
    state:AppState,
    planId?:string
):Promise<{ ok:boolean; error?:string }> {
    const maxAttempts = 6
    let lastError = 'payment_incomplete'

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            const delayMs = Math.min(
                500 * 2 ** (attempt - 1),
                4000
            )
            await new Promise(r => setTimeout(r, delayMs))
        }

        try {
            const res = await api.post(
                'billing/checkout/return',
                {
                    json: planId ? { planId } : {},
                    throwHttpErrors: false
                }
            )

            if (res.ok) {
                clearCheckoutEmail()
                await State.loadBillingStatus(state)
                return { ok: true }
            }

            const body = await res.json<{
                error?:string
            }>().catch(() => ({} as { error?:string }))
            lastError = body.error || `status_${res.status}`

            if (res.status !== 402) {
                return { ok: false, error: lastError }
            }
            // 402: keep retrying
        } catch (err) {
            lastError = err instanceof Error ?
                err.message :
                'Network error'
        }
    }

    return { ok: false, error: lastError }
}

/**
 * Notify the server that the user's checkout attempt did not
 * confirm an active subscription. The server uses this to send
 * a "payment didn't go through" email idempotently.
 */
State.signalCheckoutFailed = async function (
    _state:AppState,
    planId?:string
):Promise<void> {
    try {
        const stashed = readCheckoutEmail()
        const json:Record<string, string> = {}
        if (planId) json.planId = planId
        if (stashed) json.email = stashed

        await api.post('billing/checkout/failed', {
            json,
            throwHttpErrors: false
        })
    } catch (err) {
        debug('signalCheckoutFailed error:', err)
    }
}

/**
 * Open the Autumn-hosted customer portal in the same tab.
 */
State.openCustomerPortal = async function (
    _state:AppState
):Promise<void> {
    try {
        const res = await api.post('billing/portal', {
            throwHttpErrors: false
        })
        if (!res.ok) {
            const body = await res.json<{
                error?:string
            }>().catch(() => ({} as { error?:string }))
            throw new Error(
                body.error || `portal_${res.status}`
            )
        }
        const data = await res.json<{ url:string }>()
        window.location.assign(data.url)
    } catch (err) {
        setBillingError(err instanceof Error ?
            err.message :
            'Failed to open portal')
    }
}

/**
 * Logout
 */
State.logout = async function (
    state:AppState
):Promise<void> {
    try {
        await api.post('auth/logout')
    } catch {
        // Ignore logout errors
    }
    localStorage.removeItem(USER_STORAGE_KEY)
    batch(() => {
        state.user.value = null
        state.feeds.value = []
        state.items.value = []
    })
    resetBilling()
    state._setRoute('/login')
}

/**
 * Load feeds from remote DB
 */
State.loadFeeds = async function (
    state:AppState
):Promise<void> {
    state.feedsLoading.value = true

    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        const feeds = await adapter.getFeeds()
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
 * Add a new feed
 */
State.addFeed = async function (
    state:AppState,
    url:string
):Promise<void> {
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        await adapter.addFeed(url)
        await State.loadFeeds(state)
        await State.loadItems(state)
        await State.loadCounts(state)
    } catch (err) {
        if (
            err instanceof Error &&
            'response' in err &&
            (err as { response:Response }).response
                .status === 409
        ) {
            debug('Feed already exists, reloading...')
            await State.loadFeeds(state)
            return
        }
        throw err
    }
}

/**
 * Delete a feed
 */
State.deleteFeed = async function (
    state:AppState,
    feedId:number
):Promise<{ success:boolean; error?:string }> {
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        await adapter.deleteFeed(feedId)

        await State.loadFeeds(state)
        await State.loadItems(state)
        await State.loadCounts(state)

        return { success: true }
    } catch (err) {
        if (err instanceof Error && 'response' in err) {
            const response = (
                err as { response:Response }
            ).response
            if (response.status === 404) {
                await State.loadFeeds(state)
                await State.loadItems(state)
                await State.loadCounts(state)
                return { success: true }
            }
        }

        return {
            success: false,
            error: err instanceof Error ?
                err.message :
                'Failed to delete feed'
        }
    }
}

/**
 * Refresh all feeds
 */
State.refreshFeeds = async function (
    state:AppState
):Promise<void> {
    state.feedsLoading.value = true

    try {
        await api.post('feeds/refresh')
        await State.loadFeeds(state)
        await State.loadItems(state)
        await State.loadCounts(state)
    } finally {
        state.feedsLoading.value = false
    }
}

/**
 * Load items from remote DB with current filters
 */
State.loadItems = async function (
    state:AppState
):Promise<void> {
    state.itemsLoading.value = true

    try {
        const options:{
            feedId?:number
            isRead?:boolean
            isStarred?:boolean
            limit?:number
            offset?:number
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

        const adapter = await getAdapter(
            state.user.value?.did
        )
        const data = await adapter.getItems(options)
        state.items.value = data.items as Item[]
        state.itemsTotal.value = data.total
    } catch (err) {
        debug('Error loading items:', err)
    } finally {
        state.itemsLoading.value = false
    }
}

/**
 * Load a single item that matches a /post/* route
 */
State.loadItemByRoute = async function (
    state:AppState,
    route:string
):Promise<Item|null> {
    const itemRoute = routeToItemRoute(route)
    if (!itemRoute) return null

    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        const item = await adapter.getItemByRoute(itemRoute)
        return item as Item|null
    } catch (err) {
        debug('Error loading item by route:', err)
        return null
    }
}

/**
 * Load counts from remote DB
 */
State.loadCounts = async function (
    state:AppState
):Promise<void> {
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        const counts = await adapter.getCounts()
        state.counts.value = counts
    } catch (err) {
        debug('Error loading counts:', err)
    }
}

/**
 * Mark item as read/unread
 */
State.toggleItemRead = async function (
    state:AppState,
    itemId:number,
    isRead:boolean
):Promise<void> {
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        await adapter.updateItem(itemId, { is_read: isRead })

        batch(() => {
            state.items.value = state.items.value.map(
                item => item.id === itemId ? {
                    ...item,
                    is_read: isRead ? 1 : 0
                } : item
            )

            if (state.routeItem.value?.id === itemId) {
                state.routeItem.value = {
                    ...state.routeItem.value,
                    is_read: isRead ? 1 : 0
                }
            }
        })

        await State.loadCounts(state)
    } catch (err) {
        debug('Error toggling read status:', err)
    }
}

/**
 * Toggle item starred
 */
State.toggleItemStarred = async function (
    state:AppState,
    itemId:number,
    isStarred:boolean
):Promise<void> {
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        await adapter.updateItem(
            itemId,
            { is_starred: isStarred }
        )

        batch(() => {
            state.items.value = state.items.value.map(
                item => item.id === itemId ? {
                    ...item,
                    is_starred: isStarred ? 1 : 0
                } : item
            )

            if (state.routeItem.value?.id === itemId) {
                state.routeItem.value = {
                    ...state.routeItem.value,
                    is_starred: isStarred ? 1 : 0
                }
            }
        })

        await State.loadCounts(state)
    } catch (err) {
        debug('Error toggling starred status:', err)
    }
}

/**
 * Mark all items as read
 */
State.markAllRead = async function (
    state:AppState,
    feedId?:number
):Promise<void> {
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        await adapter.markAllRead(feedId)
        await State.loadItems(state)
        await State.loadCounts(state)
    } catch (err) {
        debug('Error marking all read:', err)
    }
}

/**
 * Strip protocol from a URL
 */
export const stripProtocol = function (
    url:string
):string {
    return url.replace(/^https?:\/\//, '')
}

/**
 * Convert an item's link to a route path
 */
export const itemToRoute = function (
    item:Item
):string|null {
    if (!item.link) return null
    try {
        const url = new URL(item.link)
        return '/post/' + url.host +
            url.pathname + url.search + url.hash
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
 * Check if a route matches an item route pattern
 */
export const isItemRoute = function (
    route:string
):boolean {
    return route.startsWith('/post/')
}

/**
 * Convert a /post/* route to the comparable link fragment
 */
export const routeToItemRoute = function (
    route:string
):string|null {
    if (!isItemRoute(route)) return null
    return route.replace(/^\/post\//, '')
}

/**
 * Find an item by its link matching the current route
 */
export const findItemByRoute = function (
    state:AppState,
    route:string
):Item|null {
    const itemRoute = routeToItemRoute(route)
    if (!itemRoute) return null

    for (const item of state.items.value) {
        const itemRoutePath = itemToRoute(item)
        if (itemRoutePath === route) {
            return item
        }

        if (item.link?.includes(itemRoute)) {
            return item
        }
    }
    return null
}
