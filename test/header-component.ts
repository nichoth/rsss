import { signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import { Header } from '../src/client/components/header.js'
import { type AppState } from '../src/client/state.js'

function headerState ():AppState {
    return {
        route: signal('/'),
        user: signal(null)
    } as AppState
}

test('Header sponsor iframes limit embed capabilities', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    try {
        render(html`<${Header} state=${headerState()} />`, root)

        const frames = Array.from(root.querySelectorAll('iframe'))

        t.equal(frames.length, 2, 'renders both sponsor iframes')

        for (const frame of frames) {
            t.equal(
                frame.getAttribute('sandbox'),
                'allow-scripts allow-same-origin',
                'sets iframe sandbox'
            )
            t.equal(
                frame.getAttribute('loading'),
                'lazy',
                'lazy-loads iframe'
            )
            t.equal(
                frame.getAttribute('referrerpolicy'),
                'no-referrer',
                'removes iframe referrers'
            )
        }
    } finally {
        render(null, root)
        root.remove()
    }
})
