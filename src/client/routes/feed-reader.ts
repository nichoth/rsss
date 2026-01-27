import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import '@substrate-system/check-box'
import '@substrate-system/tool-tip'
import { State, type AppState } from '../state.js'
import { ItemReader } from '../components/item-reader.js'
import { ItemRow } from '../components/item-row.js'
import { Header } from '../components/header.js'
import { Sidebar } from '../components/sidebar.js'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:view')

export const FeedReader: FunctionComponent<{
    state: AppState
}> = function FeedReader ({ state }) {
    const {
        feeds,
        items,
        counts,
        selectedItem,
        itemsLoading,
        showUnreadOnly,
        isOnline,
    } = state

    function handleToggleUnread () {
        state.showUnreadOnly.value = !state.showUnreadOnly.value
        state.itemsOffset.value = 0
        State.loadItems(state)
    }

    async function handleMarkAllRead () {
        await State.markAllRead(state, state.selectedFeedId.value || undefined)
    }

    // If an item is selected, show the reader view
    if (selectedItem.value) {
        return html`<${ItemReader}
            item=${selectedItem.value}
            state=${state}
            onClose=${() => State.clearSelectedItem(state)}
        />`
    }

    return html`
        <div class="route feed-reader">
            <${Header} state=${state} />

            <div class="app-body">
                <${Sidebar} state=${state} />

                <main class="content">
                    <div class="items-header">
                        <div class="items-filters">
                            <check-box
                                name="unread"
                                class="filter-checkbox"
                                checked=${showUnreadOnly.value}
                                onChange=${handleToggleUnread}
                            >
                                Unread only
                            </check-box>
                        </div>
                        <button
                            class="btn btn-small"
                            onClick=${handleMarkAllRead}
                            disabled=${counts.value.unread === 0 || !isOnline.value}
                            title=${isOnline.value ? '' : 'Cannot mark read while offline'}
                        >
                            Mark all read
                        </button>
                    </div>

                    <div class="items-list">
                        ${itemsLoading.value && items.value.length === 0 && html`
                            <div class="loading-text">Loading items...</div>
                        `}

                        ${items.value.map(item => html`
                            <${ItemRow}
                                key=${item.id}
                                item=${item}
                                state=${state}
                            />
                        `)}

                        ${!itemsLoading.value && items.value.length === 0 && html`
                            <div class="empty-state">
                                ${feeds.value.length === 0 ?
                'Maybe add some feeds to start reading.' :
                'No items to show.'}
                            </div>
                        `}
                    </div>
                </main>
            </div>
        </div>
    `
}
