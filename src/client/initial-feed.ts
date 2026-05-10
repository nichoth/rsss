import type { Item } from './db/types.js'

export interface InitialFeedPayload {
    version:number
    items:Item[]
    has_more:boolean
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
    return (
        typeof payload.version === 'number' &&
        Array.isArray(payload.items) &&
        typeof payload.has_more === 'boolean'
    )
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

export function _resetConsumedForTests ():void {
    consumed = false
}
