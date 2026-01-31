import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import '@substrate-system/check-box'
import '@substrate-system/tool-tip'
import { State, type AppState } from '../state.js'
import { ItemRow } from '../components/item-row.js'
import { Sidebar } from '../components/sidebar.js'
import Debug from '@substrate-system/debug'
const debug = Debug('rsss:view')

export const FeedReader:FunctionComponent<{
    state:AppState;
    splats:string[];
}> = function FeedReader ({ state, splats }) {
    const {
        feeds,
        items,
        counts,
        itemsLoading,
        showUnreadOnly,
        isOnline,
    } = state

    const feed = splats.shift()
    debug('feeeeeeeeeeeeeeeeeeeeeeeeed', feed)

    function handleToggleUnread () {
        state.showUnreadOnly.value = !state.showUnreadOnly.value
        state.itemsOffset.value = 0
        State.loadItems(state)
    }

    async function handleMarkAllRead () {
        await State.markAllRead(state, state.selectedFeedId.value || undefined)
    }

    return html`
        <div class="route feed-reader">
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

                    <ul class="items-list">
                        ${itemsLoading.value && items.value.length === 0 && html`
                            <div class="loading-text">Loading items...</div>
                        `}

                        ${items.value.map(item => html`
                            <li>
                            <${ItemRow}
                                key=${item.id}
                                item=${item}
                                state=${state}
                            />
                            </li>
                        `)}

                        ${!itemsLoading.value && items.value.length === 0 && html`
                            <div class="empty-state">
                                ${feeds.value.length === 0 ?
                                    'Maybe add some feeds to start reading.' :
                                    'No items to show.'}
                            </div>
                        `}
                    </ul>
                </main>
            </div>
        </div>
    `
}
