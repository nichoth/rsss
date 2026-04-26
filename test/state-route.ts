import { signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import {
    type AppState,
    type Item,
    findItemByRoute
} from '../src/client/state.js'

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
        created_at: '2024-01-01 00:00:00'
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
    } as AppState

    const result = findItemByRoute(state, '/post/example.com/posts/item')

    t.equal(result?.title, 'Exact Item', 'returns exact route match')
})
