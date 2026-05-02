import {
    type ReadonlySignal,
    type Signal,
    signal,
    computed,
    batch,
    effect
} from '@preact/signals'
import Route from 'route-event'
import ky from 'ky'
import Debug from '@substrate-system/debug'
import {
    getAdapter,
    getTabCoordinationState,
    getLocalDb,
    getRemoteItemByRoute,
    localTabLockRevision
} from './db/index.js'
import { setCurrentlyOpenItemId } from './open-item-registry.js'
import type {
    CountsResponse,
    Feed,
    Item,
    ItemsResponse
} from './db/types.js'
import {
    PullSyncAuthError,
    SyncBillingError,
    upsertItem as pullSyncUpsertItem
} from './db/pull-sync.js'
import {
    fetchFullArticle as remoteFetchFullArticle,
    FetchFullThrottledError
} from './db/remote-adapter.js'
import { storeContent } from './local-first-settings.js'
import {
    getOutboxCount,
    PushSyncAuthError,
    PushSyncBillingError
} from './db/push-sync.js'
import { runSync } from './db/sync.js'
import {
    isLocalFirstActive,
    updateOnlineStatus,
    setSyncOffline
} from './db/sync-status.js'
import {
    findItemByRoute,
    isItemRoute,
    routeToItemRoute
} from './routing.js'
import {
    type BillingStatus,
    setBillingStatus,
    setBillingError,
    setCheckoutInProgress,
    resetBilling
} from './billing-status.js'
const debug = Debug('rsss:state')

const CHECKOUT_EMAIL_KEY = 'rsss_checkout_email'
export const DEFAULT_PAGE_SIZE = 20
const SYNC_AUTH_EXPIRED = 'Your session expired. Please log in again.'
const SSE_REFRESH_DEBOUNCE_MS = 250
const REFRESH_FEEDS_SAFETY_TIMEOUT_MS = 60_000

let refreshFeedsSafetyTimeout:ReturnType<typeof setTimeout>|null = null

function clearRefreshFeedsSafetyTimeout ():void {
    if (refreshFeedsSafetyTimeout !== null) {
        clearTimeout(refreshFeedsSafetyTimeout)
        refreshFeedsSafetyTimeout = null
    }
}

let eventSource:EventSource|null = null

function hasArticleBody (item:Item):boolean {
    return Boolean(item.content || item.description)
}

function isBrowserOnline ():boolean {
    return (
        typeof navigator === 'undefined' ||
        navigator.onLine !== false
    )
}

async function fillMissingRouteBody (
    did:string|undefined,
    itemRoute:string,
    item:Item|null
):Promise<Item|null> {
    if (!item || hasArticleBody(item)) return item
    if (!did || !getLocalDb(did) || !isBrowserOnline()) return item

    try {
        const serverItem = await getRemoteItemByRoute(itemRoute)
        if (!serverItem || !hasArticleBody(serverItem)) return item
        return {
            ...item,
            content: serverItem.content,
            description: serverItem.description
        }
    } catch (err) {
        debug('Error loading missing route item content:', err)
        return item
    }
}

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
    avatar?:string
}

export type { BillingStatus }
export type {
    CountsResponse,
    Feed,
    Item,
    ItemsResponse
}
export {
    findItemByRoute,
    isItemRoute,
    itemToRoute,
    routeToItemRoute,
    stripProtocol
} from './routing.js'

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
    feedSyncStatus:Signal<
        'inactive'|'updates'|'syncing'|'error'|'synced'
    >,
    feedUpdateCounts:Signal<Record<string, number>>,
    feedUpdateStatus:ReadonlySignal<'synced'|'updates'>,
    feedsWithUpdates:ReadonlySignal<string[]>,
    items:Signal<Item[]>,
    itemsLoading:Signal<boolean>,
    itemsTotal:Signal<number>,
    itemsOffset:Signal<number>,
    counts:Signal<CountsResponse>,
    showUnreadOnly:Signal<boolean>,
    showStarredOnly:Signal<boolean>,
    pageSize:Signal<number>,
    selectedFeedId:Signal<number|null>,
    isAuthenticated:Signal<boolean>,
    cleanup:() => void
}

function updateCountsFromFeedIds (
    current:Record<string, number>,
    feedIds:string[]
):Record<string, number> {
    const next = { ...current }
    for (const feedId of feedIds) {
        next[feedId] = next[feedId] ?? 1
    }
    return next
}

function clearFeedUpdateCounts (
    current:Record<string, number>,
    feedIds:string[]
):Record<string, number> {
    const next = { ...current }
    for (const feedId of feedIds) {
        delete next[feedId]
    }
    return next
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
        feedSyncStatus: signal<
            'inactive'|'updates'|'syncing'|'error'|'synced'
        >('inactive'),
        feedUpdateCounts: signal<Record<string, number>>({}),
        // Compatibility views for existing /updates code. New writers
        // update feedSyncStatus/feedUpdateCounts as the single source.
        feedUpdateStatus: computed<'synced'|'updates'>(() => (
            state.feedSyncStatus.value === 'updates' ?
                'updates' :
                'synced'
        )),
        feedsWithUpdates: computed<string[]>(() => (
            Object.keys(state.feedUpdateCounts.value)
        )),
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
        cleanup: () => {},
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

    effect(() => {
        setCurrentlyOpenItemId(state.routeItem.value?.id ?? null)
    })

    /**
     * Load data after authentication; run pullSync when
     * local-first adapter is active. Billing status is loaded
     * in parallel so the UI can show free-vs-paid state quickly.
     */
    let authLoadGeneration = 0
    let lockRecoveryGeneration = 0
    let localTabWasBlocked = false

    const startLocalSync = (
        did:string,
        isCurrent:() => boolean
    ) => {
        getAdapter(did).then(() => {
            if (!isCurrent()) return
            const db = getLocalDb(did)
            if (db) {
                isLocalFirstActive.value = true
                runSync(db).catch((err) => {
                    if (State.handleSyncAuthError(state, err)) {
                        return
                    }
                    if (
                        err instanceof SyncBillingError ||
                        err instanceof PushSyncBillingError
                    ) {
                        State.loadBillingStatus()
                        return
                    }
                    debug('sync cycle error:', err)
                }).then(() => {
                    if (!isCurrent()) return
                    State.refreshAfterSync(state)
                })
            } else {
                isLocalFirstActive.value = false
                State.refreshAfterSync(state)
            }
        })
    }

    effect(() => {
        const user = state.user.value
        const generation = ++authLoadGeneration

        if (!user) return

        queueMicrotask(() => {
            if (generation !== authLoadGeneration) return
            State.loadBillingStatus()

            startLocalSync(
                user.did,
                () => generation === authLoadGeneration
            )
        })
    })

    effect(() => {
        const lockRevision = localTabLockRevision.value
        const user = state.user.value
        const tabState = getTabCoordinationState()

        if (lockRevision === 0 && tabState === 'idle') return
        if (tabState === 'blocked') {
            localTabWasBlocked = true
            return
        }
        if (!user || !localTabWasBlocked || tabState !== 'waiting') return

        localTabWasBlocked = false
        const generation = ++lockRecoveryGeneration
        queueMicrotask(() => {
            if (generation !== lockRecoveryGeneration) return
            startLocalSync(
                user.did,
                () => generation === lockRecoveryGeneration
            )
        })
    })

    const handleOnline = () => {
        updateOnlineStatus()
        if (!isLocalFirstActive.value) return
        const did = state.user.value?.did
        const db = getLocalDb(did)
        if (db) {
            runSync(db).then(() => {
                State.refreshAfterSync(state)
            }).catch((err) => {
                if (State.handleSyncAuthError(state, err)) {
                    return
                }
                if (
                    err instanceof SyncBillingError ||
                    err instanceof PushSyncBillingError
                ) {
                    State.loadBillingStatus()
                    return
                }
                debug('sync cycle online error:', err)
            })
        }
    }

    const handleOffline = () => {
        const did = state.user.value?.did
        const db = getLocalDb(did)
        if (!db) {
            setSyncOffline(0)
            return
        }
        getOutboxCount(db)
            .then((pending) => setSyncOffline(pending))
            .catch((err) => {
                debug('offline pending count error:', err)
                setSyncOffline(0)
            })
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    state.cleanup = () => {
        window.removeEventListener('online', handleOnline)
        window.removeEventListener('offline', handleOffline)
        State.closeEventStream()
    }

    State.checkAuth(state)

    return state
}

State.handleSyncAuthError = function (
    state:AppState,
    err:unknown
):boolean {
    if (
        !(err instanceof PullSyncAuthError) &&
        !(err instanceof PushSyncAuthError)
    ) {
        return false
    }

    batch(() => {
        state.user.value = null
        state.authError.value = SYNC_AUTH_EXPIRED
    })
    state._setRoute('/login')
    return true
}

// local-first DB sync, NOT server feed pull -- safe to call automatically
State.refreshAfterSync = async function (
    state:AppState
):Promise<void> {
    const route = state.route.value

    await Promise.all([
        State.loadFeeds(state),
        State.loadItems(state),
        State.loadCounts(state)
    ])

    if (!isItemRoute(route)) return

    const item = await State.loadItemByRoute(state, route)
    if (state.route.value !== route) return

    batch(() => {
        state.routeItem.value = item
        state.routeItemLoading.value = false
    })
}

function buildItemOptions (state:AppState):{
    feedId?:number;
    isRead?:boolean;
    isStarred?:boolean;
    limit?:number;
    offset?:number;
} {
    const options:{
        feedId?:number;
        isRead?:boolean;
        isStarred?:boolean;
        limit?:number;
        offset?:number;
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

    return options
}

/**
 * Subscribe to server-sent events from the user's Durable Object.
 * The DO broadcasts `feed-updated` after each feed fetch completes
 * (initial add, manual refresh, alarm-driven refresh). On those
 * events we re-read state from the server.
 */
State.openEventStream = function (state:AppState):void {
    if (eventSource) return

    const source = new EventSource('/api/events', {
        withCredentials: true
    })
    eventSource = source

    let pendingRefresh:ReturnType<typeof setTimeout>|null = null
    const scheduleRefresh = () => {
        if (pendingRefresh !== null) return
        pendingRefresh = setTimeout(() => {
            pendingRefresh = null
            State.refreshAfterSync(state)
        }, SSE_REFRESH_DEBOUNCE_MS)
    }

    source.addEventListener('feed-updated', () => {
        debug('SSE feed-updated')
        scheduleRefresh()
    })

    source.addEventListener('refresh-complete', () => {
        debug('SSE refresh-complete')
        clearRefreshFeedsSafetyTimeout()
        // local-first DB sync, NOT server feed pull
        batch(() => {
            state.feedsLoading.value = false
            state.feedUpdateCounts.value = {}
            state.feedSyncStatus.value = 'synced'
        })
    })

    source.addEventListener('feed-updates-available', (ev) => {
        debug('SSE feed-updates-available', ev.data)
        try {
            const { feedIds } = JSON.parse(ev.data) as {
                feedIds:string[]
            }
            batch(() => {
                state.feedUpdateCounts.value = updateCountsFromFeedIds(
                    state.feedUpdateCounts.value,
                    feedIds
                )
                state.feedSyncStatus.value = 'updates'
            })
        } catch (err) {
            debug('feed-updates-available parse error:', err)
        }
    })

    source.addEventListener('feed-updates-cleared', (ev) => {
        debug('SSE feed-updates-cleared', ev.data)
        try {
            const { feedIds } = JSON.parse(ev.data) as {
                feedIds:string[]
            }
            batch(() => {
                const counts = clearFeedUpdateCounts(
                    state.feedUpdateCounts.value,
                    feedIds
                )
                state.feedUpdateCounts.value = counts
                if (Object.keys(counts).length === 0) {
                    state.feedSyncStatus.value = 'synced'
                }
            })
        } catch (err) {
            debug('feed-updates-cleared parse error:', err)
        }
    })

    source.addEventListener('error', (ev) => {
        debug('SSE error (auto-reconnect)', ev)
    })
}

State.closeEventStream = function ():void {
    if (!eventSource) return
    eventSource.close()
    eventSource = null
}

/**
 * API client
 */
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
                handle:string;
                avatar?:string
            }>()
            if (data.authenticated) {
                const user:User = {
                    did: data.did,
                    handle: data.handle,
                    avatar: data.avatar
                }
                state.user.value = user
                State.openEventStream(state)
            } else {
                state.user.value = null
                State.closeEventStream()
            }
        } else {
            state.user.value = null
            State.closeEventStream()
        }
    } catch {
        state.user.value = null
        State.closeEventStream()
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
        await State.loadBillingStatus()
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
            await new Promise(resolve => setTimeout(resolve, delayMs))
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
                await State.loadBillingStatus()
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
 * Schedule deletion of the current user's account. Resolves with
 * the scheduled deletion timestamp (in ms). Updates billingStatus
 * so the settings UI reflects the pending state.
 */
State.scheduleAccountDeletion = async function (
):Promise<{ scheduledFor:number }> {
    const res = await api.post('account/delete', {
        throwHttpErrors: false
    })
    if (!res.ok) {
        const body = await res.json<{
            error?:string
        }>().catch(() => ({} as { error?:string }))
        throw new Error(
            body.error || `account_delete_${res.status}`
        )
    }
    const data = await res.json<{ scheduledFor:number }>()

    // Refresh billing status so settings reflects the pending
    // deletion without an extra round-trip.
    await State.loadBillingStatus()
    return data
}

/**
 * Cancel a pending account deletion.
 */
State.cancelAccountDeletion = async function (
):Promise<void> {
    const res = await api.delete('account/delete', {
        throwHttpErrors: false
    })
    if (!res.ok) {
        const body = await res.json<{
            error?:string
        }>().catch(() => ({} as { error?:string }))
        throw new Error(
            body.error || `cancel_delete_${res.status}`
        )
    }
    await State.loadBillingStatus()
}

/**
 * Open the Autumn-hosted customer portal in the same tab.
 */
State.openCustomerPortal = async function (
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
    let serverLogoutOk = false
    try {
        const res = await api.post('auth/logout', {
            throwHttpErrors: false
        })
        serverLogoutOk = res.ok
        if (!res.ok) {
            debug('logout request failed:', res.status)
        }
    } catch (err) {
        debug('logout request error:', err)
    }
    batch(() => {
        state.user.value = null
        state.feeds.value = []
        state.items.value = []
        state.authError.value = serverLogoutOk ?
            null :
            'Logout may not have completed. Please clear cookies' +
                ' if you continue to see your account.'
    })
    State.closeEventStream()
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
        const data = await adapter.getFeeds()
        batch(() => {
            const feedUpdateCounts = data.feedUpdateCounts ??
                updateCountsFromFeedIds(
                    {},
                    data.feedsWithUpdates ?? []
                )
            const pendingUpdates = Object.values(feedUpdateCounts)
                .reduce((sum, count) => sum + count, 0)

            state.feeds.value = data.feeds
            state.feedUpdateCounts.value = feedUpdateCounts
            state.feedSyncStatus.value = pendingUpdates > 0 ?
                'updates' :
                'synced'
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

    clearRefreshFeedsSafetyTimeout()
    refreshFeedsSafetyTimeout = setTimeout(() => {
        refreshFeedsSafetyTimeout = null
        state.feedsLoading.value = false
    }, REFRESH_FEEDS_SAFETY_TIMEOUT_MS)

    try {
        await api.post('feeds/refresh')
    } catch (err) {
        clearRefreshFeedsSafetyTimeout()
        state.feedsLoading.value = false
        throw err
    }
    // Spinner stays on until SSE 'refresh-complete' (or the
    // safety timeout) clears it.
}

/**
 * Load items from remote DB with current filters
 */
State.loadItems = async function (
    state:AppState
):Promise<void> {
    state.itemsLoading.value = true

    let data:ItemsResponse|null = null
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        data = await adapter.getItems(buildItemOptions(state))
    } catch (err) {
        debug('Error loading items:', err)
    }

    batch(() => {
        if (data) {
            state.items.value = data.items as Item[]
            state.itemsTotal.value = data.total
        }
        state.itemsLoading.value = false
    })
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
        const did = state.user.value?.did
        const adapter = await getAdapter(did)
        const item = await adapter.getItemByRoute(itemRoute)
        return fillMissingRouteBody(did, itemRoute, item as Item|null)
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
 * Per-tab tracking for in-flight on-demand article fetches. Only one
 * item is open in the reader at a time, so a single nullable signal
 * is sufficient.
 */
export const articleFetchingItemId:Signal<number|null> = signal(null)
export const articleFetchError:Signal<{
    itemId:number
    message:string
}|null> = signal(null)

State.fetchFullArticle = async function (
    state:AppState,
    itemId:number,
    opts:{ force?:boolean } = {}
):Promise<void> {
    batch(() => {
        articleFetchingItemId.value = itemId
        articleFetchError.value = null
    })

    let result:{ item:Item }
    try {
        result = await remoteFetchFullArticle(itemId, opts)
    } catch (err) {
        const message = err instanceof FetchFullThrottledError ?
            `Try again in ${err.retryAfterSeconds}s` :
            err instanceof Error ? err.message : String(err)
        batch(() => {
            articleFetchingItemId.value = null
            articleFetchError.value = { itemId, message }
        })
        debug('fetchFullArticle error:', err)
        return
    }

    const updated = result.item

    // Mirror the row into the local DB if local-first is active.
    const did = state.user.value?.did
    if (did) {
        const db = getLocalDb(did)
        if (db) {
            try {
                await pullSyncUpsertItem(
                    db,
                    updated as unknown as Record<string, unknown>,
                    storeContent.value
                )
            } catch (err) {
                debug('fetchFullArticle local upsert error:', err)
            }
        }
    }

    batch(() => {
        state.items.value = state.items.value.map(
            existing => existing.id === itemId ? {
                ...existing,
                ...updated
            } : existing
        )
        if (state.routeItem.value?.id === itemId) {
            state.routeItem.value = {
                ...state.routeItem.value,
                ...updated
            }
        }
        articleFetchingItemId.value = null
        articleFetchError.value = null
    })
}

/**
 * Refresh a single feed and advance the client cursor
 */
State.refreshFeed = async function (
    state:AppState,
    feedId:string
):Promise<void> {
    await api.post(`feeds/${feedId}/refresh`)
    batch(() => {
        const counts = clearFeedUpdateCounts(
            state.feedUpdateCounts.value,
            [feedId]
        )
        state.feedUpdateCounts.value = counts
        if (Object.keys(counts).length === 0) {
            state.feedSyncStatus.value = 'synced'
        }
    })
}

/**
 * Clear selected item and navigate back to list
 */
State.clearSelectedItem = function (state:AppState):void {
    state._setRoute('/')
}
