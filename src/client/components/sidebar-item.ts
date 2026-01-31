import { html } from 'htm/preact'
import { useCallback } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { useComputed } from '@preact/signals'
import { State, type AppState } from '../state'
import './sidebar-item.css'

export const SidebarItem:FunctionComponent<{
    state:AppState,
    starred:boolean  // two options -- starred, or all items
}> = function (props) {
    const { state, starred } = props
    const { showStarredOnly, counts, route } = state

    const isActive = useComputed<boolean>(() => {
        // Not active if we're on a feed-specific route
        if (route.value.startsWith('/feed/')) return false
        if (starred && showStarredOnly.value) return true
        if (!starred && !showStarredOnly.value) return true
        return false
    })

    const handleShowAll = useCallback(() => {
        State.showAll(state)
        state._setRoute('/')
    }, [])

    const handleShowStarred = useCallback(() => {
        State.showStarred(state)
        state._setRoute('/')
    }, [])

    return html`<button
        class="sidebar-item ${isActive.value ? 'active' : ''}"
        onClick=${starred ? handleShowStarred : handleShowAll}
    >
        <span>${props.children}</span>
        <span class="badge">
            ${starred ? counts.value.starred : counts.value.unread}
        </span>
    </button>`
}
