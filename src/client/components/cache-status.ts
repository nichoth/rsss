import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { State, type AppState } from '../state.js'
import { billingStatus } from '../billing-status.js'
import {
    storeContent,
    syncSubscriptions
} from '../local-first-settings.js'
import {
    cacheStatus,
    cacheActionInProgress,
    cacheActionProgress,
    cacheActionError
} from '../cache-status-state.js'
import { Dot } from './dot.js'
import './cache-status.css'

export const CacheStatus:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const [open, setOpen] = useState(false)
    const wrapperRef = useRef<HTMLSpanElement>(null)

    const handleToggle = useCallback(() => {
        setOpen(o => !o)
    }, [])

    const handleCacheClick = useCallback(async () => {
        await State.cacheUncachedItems(state)
    }, [state])

    useEffect(() => {
        if (!open) return undefined
        function onDown (ev:MouseEvent|TouchEvent) {
            const el = wrapperRef.current
            if (!el) return
            const target = ev.target as Node|null
            if (target && el.contains(target)) return
            setOpen(false)
        }
        function onKey (ev:KeyboardEvent) {
            if (ev.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('touchstart', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('touchstart', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    // Auto-close when uncached drops to 0 after an action
    useEffect(() => {
        if (
            open &&
            !cacheActionInProgress.value &&
            (cacheStatus.value?.uncachedCount ?? 0) === 0
        ) {
            setOpen(false)
        }
    }, [
        open,
        cacheActionInProgress.value,
        cacheStatus.value?.uncachedCount
    ])

    if (!state.user.value) return null
    const billing = billingStatus.value
    if (!billing || !billing.entitled) return null
    if (!syncSubscriptions.value) return null
    if (!storeContent.value) return null

    const snapshot = cacheStatus.value
    if (snapshot === null) return null

    if (snapshot.totalCount === 0) {
        return html`
            <span
                class="cache-status empty"
                role="status"
                aria-label="Cache status: no items yet"
            >
                <span class="cache-status-legend">No items yet</span>
                <${Dot} color="gray" />
            </span>
        `
    }

    if (snapshot.uncachedCount === 0) {
        return html`
            <span
                class="cache-status synced"
                role="status"
                aria-label="Cache status: 100% cached"
            >
                <span class="cache-status-legend">100% cached</span>
                <${Dot} color="green" />
            </span>
        `
    }

    const inProgress = cacheActionInProgress.value
    const progress = cacheActionProgress.value
    const error = cacheActionError.value
    const label = `${snapshot.uncachedCount} uncached`
    const buttonLabel = inProgress && progress ?
        `Caching ${progress.current} of ${progress.total}...` :
        'Cache'

    return html`
        <span
            ref=${wrapperRef}
            class="cache-status uncached"
            role="status"
            aria-label=${`Cache status: ${label}`}
        >
            <span class="cache-status-legend">${label}</span>
            <button
                type="button"
                class="cache-status-toggle"
                aria-haspopup="dialog"
                aria-expanded=${open}
                aria-label=${
                    `${label}. Click to open cache action menu.`
                }
                onClick=${handleToggle}
            >
                <${Dot} color="yellow" />
            </button>

            ${open && html`
                <div class="cache-status-popover" role="dialog">
                    <div class="cache-status-summary">
                        ${snapshot.uncachedCount} of ${snapshot.totalCount}
                        ${' '}items uncached
                    </div>
                    <button
                        type="button"
                        class="btn btn-small"
                        onClick=${handleCacheClick}
                        disabled=${inProgress}
                    >
                        ${buttonLabel}
                    </button>
                    ${error && html`
                        <div class="cache-status-error" role="alert">
                            ${error}
                        </div>
                    `}
                </div>
            `}
        </span>
    `
}
