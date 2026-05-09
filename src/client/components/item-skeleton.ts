import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state.js'
import { Header } from './header.js'
import './page-skeleton.css'

const PARAGRAPH_LINE_COUNT = 8

const lineModifier = (i:number):string => {
    const m = i % 4
    if (m === 3) return ' is-short'
    if (m === 2) return ' is-medium'
    return ''
}

export const ItemSkeleton:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    return html`
        <${Header} state=${state} />
        <article
            class="route item-reader skeleton"
            aria-busy="true"
        >
            <p class="visually-hidden" role="status">
                Loading article
            </p>
            <span
                class="skeleton-block skeleton-back-link"
                aria-hidden="true"
            ></span>
            <span
                class="skeleton-block skeleton-article-title"
                aria-hidden="true"
            ></span>
            <span
                class="skeleton-block skeleton-article-meta"
                aria-hidden="true"
            ></span>
            ${Array.from(
                { length: PARAGRAPH_LINE_COUNT },
                (_, i) => html`
                    <span
                        class="skeleton-block skeleton-article-line${
                            lineModifier(i)
                        }"
                        aria-hidden="true"
                        key=${i}
                    ></span>
                `
            )}
        </article>
    `
}
