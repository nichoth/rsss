import { signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import { ItemRow } from '../src/client/components/item-row.js'
import { type AppState, type Item } from '../src/client/state.js'

function rowState ():AppState {
    return {
        items: signal([]),
        route: signal('/'),
        _setRoute: () => {}
    } as unknown as AppState
}

function item (
    overrides:Partial<Item> = {}
):Item {
    return {
        id: 1,
        feed_id: 1,
        guid: 'guid-1',
        title: 'Thumbnail story',
        link: 'https://example.com/story',
        description: 'Story summary',
        content: null,
        author: null,
        pub_date: null,
        thumbnail_url: null,
        is_read: 0,
        is_starred: 0,
        created_at: '2024-01-01 00:00:00',
        updated_at: '2024-01-01 00:00:00',
        feed_title: 'Example Feed',
        ...overrides
    }
}

function renderRow (row:Item):HTMLDivElement {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)
    render(html`<${ItemRow} item=${row} state=${rowState()} />`, root)
    return root
}

test('ItemRow renders a decorative thumbnail before item text', t => {
    const root = renderRow(item({
        thumbnail_url: 'https://cdn.example.com/thumb.jpg'
    }))

    try {
        const link = root.querySelector('.item-link') as HTMLAnchorElement
        const thumbnail = link.querySelector(
            '.item-thumbnail'
        ) as HTMLImageElement

        t.ok(thumbnail, 'renders thumbnail image')
        t.equal(
            link.firstElementChild,
            thumbnail,
            'places thumbnail before the item body'
        )
        if (thumbnail) {
            t.equal(
                thumbnail.nextElementSibling?.className,
                'item-main',
                'keeps item text after thumbnail'
            )
            t.equal(
                thumbnail.getAttribute('src'),
                'https://cdn.example.com/thumb.jpg',
                'uses the thumbnail URL'
            )
            t.equal(thumbnail.getAttribute('loading'), 'lazy')
            t.equal(thumbnail.getAttribute('decoding'), 'async')
            t.equal(thumbnail.getAttribute('referrerpolicy'), 'no-referrer')
            t.equal(thumbnail.getAttribute('alt'), '')
        }
    } finally {
        render(null, root)
        root.remove()
    }
})

test('ItemRow does not reserve thumbnail DOM without a URL', t => {
    const root = renderRow(item({ thumbnail_url: '' }))

    try {
        const link = root.querySelector('.item-link') as HTMLAnchorElement

        t.equal(
            root.querySelector('.item-thumbnail'),
            null,
            'does not render a placeholder image'
        )
        t.equal(
            link.firstElementChild?.className,
            'item-main',
            'keeps the original first child for rows without thumbnails'
        )
    } finally {
        render(null, root)
        root.remove()
    }
})

test('ItemRow removes a thumbnail after the image fails', async t => {
    const root = renderRow(item({
        thumbnail_url: 'data:image/png;base64,not-valid'
    }))

    try {
        const thumbnail = root.querySelector(
            '.item-thumbnail'
        ) as HTMLImageElement

        t.ok(thumbnail, 'starts with thumbnail image')
        const startedAt = Date.now()

        while (
            root.querySelector('.item-thumbnail') &&
            Date.now() - startedAt < 1000
        ) {
            await new Promise(resolve => setTimeout(resolve, 20))
        }

        t.equal(
            root.querySelector('.item-thumbnail'),
            null,
            'removes the broken thumbnail'
        )
    } finally {
        render(null, root)
        root.remove()
    }
})
