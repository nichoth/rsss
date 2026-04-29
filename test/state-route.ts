import { signal } from '@preact/signals'
import type { Signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import type { Item } from '../src/client/db/types.js'
import { findItemByRoute } from '../src/client/routing.js'
import { ItemReader } from '../src/client/routes/item-reader.js'
import { type AppState } from '../src/client/state.js'

type RouteState = {
    items:Signal<Item[]>
}

function item (
    id:number,
    link:string,
    title:string
):Item {
    return {
        id,
        feed_id: 1,
        guid: `guid-${id}`,
        title,
        link,
        description: null,
        content: null,
        author: null,
        pub_date: null,
        thumbnail_url: null,
        is_read: 0,
        is_starred: 0,
        created_at: '2024-01-01 00:00:00',
        updated_at: '2024-01-01 00:00:00'
    }
}

test('findItemByRoute returns exact match for overlapping paths', t => {
    const state = {
        items: signal([
            item(
                1,
                'https://example.com/posts/item-extra',
                'Overlap Item'
            ),
            item(
                2,
                'https://example.com/posts/item',
                'Exact Item'
            )
        ])
    } as RouteState

    const result = findItemByRoute(state, '/post/example.com/posts/item')

    t.equal(result?.title, 'Exact Item', 'returns exact route match')
})

test('ItemReader renders unavailable state for offline missing content',
    t => {
        const originalOnline = Object.getOwnPropertyDescriptor(
            navigator,
            'onLine'
        )
        Object.defineProperty(navigator, 'onLine', {
            value: false,
            configurable: true
        })

        const body = document.querySelector('body') as HTMLElement
        const root = document.createElement('div')
        body.appendChild(root)

        const state = {
            route: signal('/post/example.com/posts/item'),
            routeItem: signal(item(
                2,
                'https://example.com/posts/item',
                'Exact Item'
            )),
            routeItemLoading: signal(false),
            items: signal([]),
            _setRoute: () => {}
        } as unknown as AppState

        try {
            render(
                html`<${ItemReader} state=${state} splats=${[]} />`,
                root
            )

            const unavailable = root.querySelector(
                '.article-unavailable'
            )
            t.equal(
                unavailable?.textContent?.trim(),
                'Article content unavailable offline.',
                'shows unavailable copy instead of crashing'
            )
        } finally {
            render(null, root)
            root.remove()
            if (originalOnline) {
                Object.defineProperty(
                    navigator,
                    'onLine',
                    originalOnline
                )
            }
        }
    })
