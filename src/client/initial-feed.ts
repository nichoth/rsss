import type { CountsResponse, Feed, Item } from './db/types.js'

export interface InitialFeedPayload {
    version:number
    items:Item[]
    has_more:boolean
    feeds?:Feed[]
    counts?:CountsResponse
}

declare global {
    interface Window {
        __INITIAL_FEED__?:InitialFeedPayload
    }
}

let consumed = false

function isInitialFeedPayload (
    value:unknown
):value is InitialFeedPayload {
    if (!value || typeof value !== 'object') return false

    const payload = value as Partial<InitialFeedPayload>
    if (typeof payload.version !== 'number') return false
    if (!Array.isArray(payload.items)) return false
    if (typeof payload.has_more !== 'boolean') return false

    if (
        payload.feeds !== undefined &&
        !Array.isArray(payload.feeds)
    ) {
        return false
    }
    if (
        payload.counts !== undefined &&
        (typeof payload.counts !== 'object' || payload.counts === null)
    ) {
        return false
    }

    return true
}

export function readInitialFeedFromDom ():InitialFeedPayload|null {
    if (typeof document === 'undefined') return null

    const script = document.querySelector<HTMLScriptElement>(
        '#initial-feed'
    )
    if (!script?.textContent) return null

    try {
        const parsed:unknown = JSON.parse(script.textContent)
        return isInitialFeedPayload(parsed) ? parsed : null
    } catch {
        return null
    }
}

export function consumeInitialFeed ():InitialFeedPayload|null {
    if (consumed) return null
    consumed = true

    if (typeof window === 'undefined') {
        return readInitialFeedFromDom()
    }

    const globalPayload = window.__INITIAL_FEED__
    delete window.__INITIAL_FEED__

    if (isInitialFeedPayload(globalPayload)) {
        return globalPayload
    }

    return readInitialFeedFromDom()
}

/**
 * Read the bootstrap payload without marking it consumed. Used by
 * `State()` to seed feeds/counts synchronously while leaving the
 * items consumption to `loadItems()` (which expects single-use).
 */
export function peekInitialFeed ():InitialFeedPayload|null {
    if (typeof window === 'undefined') return readInitialFeedFromDom()

    const globalPayload = window.__INITIAL_FEED__
    if (isInitialFeedPayload(globalPayload)) {
        return globalPayload
    }

    return readInitialFeedFromDom()
}

export function _resetConsumedForTests ():void {
    consumed = false
}
