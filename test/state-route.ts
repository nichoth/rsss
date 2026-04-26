import { signal } from '@preact/signals'
import type { Signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import type { Item } from '../src/client/db/types.js'
import { findItemByRoute } from '../src/client/routing.js'

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
