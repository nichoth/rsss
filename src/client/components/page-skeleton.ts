import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state.js'
import { Header } from './header.js'
import './page-skeleton.css'

const FEED_ROW_COUNT = 5
const ITEM_ROW_COUNT = 6

export const PageSkeleton:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    return html`
        <${Header} state=${state} />
        <div
            class="route feed-reader skeleton"
            aria-busy="true"
        >
            <p class="visually-hidden" role="status">
                Loading feeds and articles
            </p>
            <div class="app-body">
                <aside class="sidebar skeleton-sidebar">
                    <div class="skeleton-section">
                        <div class="skeleton-feed-row">
                            <span
                                class="skeleton-block skeleton-badge"
                                aria-hidden="true"
                            ></span>
                            <span
                                class="skeleton-block skeleton-feed-name"
                                aria-hidden="true"
                            ></span>
                        </div>
                        <div class="skeleton-feed-row">
                            <span
                                class="skeleton-block skeleton-badge"
                                aria-hidden="true"
                            ></span>
                            <span
                                class="skeleton-block skeleton-feed-name"
                                aria-hidden="true"
                            ></span>
                        </div>
                    </div>

                    <div class="skeleton-section">
                        <div class="skeleton-section-header">
                            <h3>Feeds</h3>
                        </div>
                        ${Array.from(
                            { length: FEED_ROW_COUNT },
                            (_, i) => html`
                                <div
                                    class="skeleton-feed-row"
                                    key=${i}
                                >
                                    <span
                                        class="skeleton-block skeleton-badge"
                                        aria-hidden="true"
                                    ></span>
                                    <span
                                        class="skeleton-block skeleton-feed-name"
                                        aria-hidden="true"
                                        style=${`width: ${
                                            45 + ((i * 17) % 35)
                                        }%`}
                                    ></span>
                                </div>
                            `
                        )}
                    </div>
                </aside>

                <main class="content skeleton-main">
                    <div class="skeleton-items-header">
                        <span
                            class="skeleton-block skeleton-items-header-block is-filter"
                            aria-hidden="true"
                        ></span>
                        <span
                            class="skeleton-block skeleton-items-header-block is-action"
                            aria-hidden="true"
                        ></span>
                    </div>
                    <ul class="items-list">
                        ${Array.from(
                            { length: ITEM_ROW_COUNT },
                            (_, i) => html`
                                <li
                                    class="skeleton-item-row"
                                    key=${i}
                                >
                                    <div class="skeleton-item-body">
                                        <span
                                            class="skeleton-block skeleton-item-title"
                                            aria-hidden="true"
                                            style=${`width: ${
                                                55 + ((i * 13) % 35)
                                            }%`}
                                        ></span>
                                        <span
                                            class="skeleton-block skeleton-item-meta"
                                            aria-hidden="true"
                                        ></span>
                                        <span
                                            class="skeleton-block skeleton-item-excerpt"
                                            aria-hidden="true"
                                        ></span>
                                        <span
                                            class="skeleton-block skeleton-item-excerpt is-short"
                                            aria-hidden="true"
                                        ></span>
                                    </div>
                                </li>
                            `
                        )}
                    </ul>
                </main>
            </div>
        </div>
    `
}
