import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import { useState, useCallback } from 'preact/hooks'
import { CogWheel } from './cog-wheel.js'
import { SidebarItem } from './sidebar-item.js'
import { SidebarFooter } from '../components/sidebar-footer.js'
import { Button } from '../components/button.js'
import { CloseIcon } from '../components/close.js'
import { ELLIPSIS } from '../constants.js'
import { ButtonIcon } from './button-icon.js'
import {
    type Feed,
    type AppState,
    State,
    stripProtocol
} from '../state.js'
import './sidebar.css'
import Debug from '@substrate-system/debug'
const debug = Debug('rsss:view')

export const Sidebar:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const {
        feedsLoading,
        feeds,
        route,
        counts,
    } = state
    const [showAddFeed, setShowAddFeed] = useState(false)
    const [addingFeed, setAddingFeed] = useState(false)
    const [addFeedError, setAddFeedError] = useState<
        string|null
    >(null)

    async function handleDeleteFeed (feed:Feed) {
        if (confirm(
            `Delete "${feed.title || feed.url}"?`
        )) {
            debug('deleting feed', feed.id)
            await State.deleteFeed(state, feed.id)
            debug(
                'done deleting it...',
                'feed ID: ' + feed.id
            )
        }
    }

    const handleAddFeed = useCallback(async (
        ev:MouseEvent
    ) => {
        ev.preventDefault()
        const form = ev.target as HTMLFormElement
        const els = form.elements
        const input = els.namedItem(
            'new-feed-url'
        ) as HTMLInputElement
        const newFeedUrl = input.value
        if (!newFeedUrl.trim()) return
        debug('adding a new feed...', newFeedUrl)

        setAddingFeed(true)
        setAddFeedError(null)

        try {
            const result = await State.addFeed(
                state,
                newFeedUrl.trim()
            )
            debug('done adding feed...', result)

            input.value = ''
            setShowAddFeed(false)
        } catch (_err) {
            const err = _err as Error
            setAddFeedError(
                (err as Error).message ||
                'Failed to add feed'
            )
        }

        setAddingFeed(false)
    }, [])

    const allFeeds = !route.value.startsWith('/feed/')

    return html`
        <aside class="sidebar">
            <div class="sidebar-section">
                <${SidebarItem} state=${state} starred=${false}>
                    All Items
                <//>
                <${SidebarItem} state=${state} starred=${true}>
                    Starred
                <//>
            </div>

            <div class="sidebar-section">
                <div class="sidebar-header">
                    <h3>Feeds</h3>
                    <div class="feeds-controls">
                        <a class="cog-wheel" href="/settings">
                            <${CogWheel} />
                        </a>
                        <${ButtonIcon}
                            class="btn btn-icon"
                            onClick=${() => setShowAddFeed(
                                !showAddFeed
                            )}
                            title="Add feed"
                        >
                            +
                        <//>
                    </div>
                </div>

                ${showAddFeed && html`
                    <form
                        class="add-feed-form"
                        onSubmit=${handleAddFeed}
                    >
                        <input
                            type="url"
                            id="new-feed-url"
                            name="new-feed-url"
                            placeholder="https://example.com/feed.xml"
                            disabled=${addingFeed}
                        />
                        <${Button} type="submit">
                            ${addingFeed ? '...' : 'Add'}
                        <//>
                        ${addFeedError && html`<div
                            class="form-error"
                        >
                            ${addFeedError}
                        </div>`}
                    </form>
                `}

                <div class="feeds-list">
                    <div class="sidebar-item feed-item${
                        allFeeds ? ' active' : ''
                    }">
                        <span class="badge feed-unread-count">
                            ${counts.value.unread}
                        </span>
                        <a class="feed-select" href="/">
                            All Feeds
                        </a>
                    </div>

                    ${feedsLoading.value &&
                        feeds.value.length === 0 && html`
                        <div class="loading-text">
                            Loading feeds...
                        </div>
                    `}

                    ${feeds.value.map(feed => {
                        const feedPath = stripProtocol(
                            feed.url
                        )
                        const isActive = route.value ===
                            `/feed/${feedPath}`
                        const feedUnread = counts.value
                            .perFeed[String(feed.id)] ?? 0
                        return html`
                            <div
                                class="sidebar-item feed-item ${
                                    isActive ? 'active' : ''
                                }"
                                key=${feed.id}
                            >
                                <span class="badge feed-unread-count">
                                    ${feedUnread}
                                </span>
                                <a
                                    class="feed-select"
                                    href="/feed/${feedPath}"
                                >
                                    ${feed.title || feed.url}
                                </a>

                            <div class="item-controls">
                                <tool-tip
                                    content="Delete feed"
                                    delay="500"
                                >
                                    <button
                                        class="btn-delete"
                                        onClick=${() => handleDeleteFeed(feed)}
                                        aria-label="Delete feed"
                                    >
                                        <${CloseIcon} />
                                    </button>
                                </tool-tip>
                            </div>
                        </div>
                    `
                        })}

                    ${((!feedsLoading.value &&
                        feeds.value.length === 0) &&
                        html`
                            <div class="empty-state">
                                No feeds yet${ELLIPSIS}
                            </div>
                        `)
}
                </div>
            </div>

            <${SidebarFooter} state=${state} />
        </aside>
    `
}
