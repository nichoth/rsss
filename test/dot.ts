import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import css from '../src/client/components/dot.css'
import { Dot } from '../src/client/components/dot.js'

test('Dot CSS defines gray and blue using color variables', t => {
    const dotCss = String(css)

    t.ok(dotCss.includes('&.gray'), 'defines gray dot style')
    t.ok(dotCss.includes('&.blue'), 'defines blue dot style')
    t.ok(
        /&\.gray\s*{[^}]*fill:\s*var\(--color-dot-gray\)/s.test(dotCss),
        'gray dot fill uses the gray dot variable'
    )
    t.ok(
        /&\.blue\s*{[^}]*fill:\s*var\(--color-dot-blue\)/s.test(dotCss),
        'blue dot fill uses the blue dot variable'
    )
})

test('Dot CSS defines red and green using color variables', t => {
    const dotCss = String(css)

    t.ok(
        /&\.red\s*{[^}]*fill:\s*var\(--color-dot-red\)/s.test(dotCss),
        'red dot fill uses the red dot variable (error state, FR-012)'
    )
    t.ok(
        /&\.green\s*{[^}]*fill:\s*var\(--color-dot-green\)/s.test(dotCss),
        'green dot fill uses the green dot variable (up to date)'
    )
})

function renderDot (color:'red'|'blue'|'green'|'gray'|'yellow'):{
    root:HTMLElement
    cleanup:() => void
} {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)
    render(html`<${Dot} color=${color} />`, root)
    return {
        root,
        cleanup () {
            render(null, root)
            root.remove()
        }
    }
}

test('Dot renders red svg class when color=red (error state)', t => {
    const { root, cleanup } = renderDot('red')
    try {
        const dot = root.querySelector('svg.dot')
        t.ok(dot, 'renders an svg dot')
        t.ok(dot?.classList.contains('red'), 'has the red modifier class')
    } finally {
        cleanup()
    }
})

test('Dot renders blue svg class when totalPending > 0 (updates)', t => {
    const { root, cleanup } = renderDot('blue')
    try {
        const dot = root.querySelector('svg.dot')
        t.ok(dot?.classList.contains('blue'), 'has the blue modifier class')
    } finally {
        cleanup()
    }
})

test('Dot renders green svg class when totalPending === 0 (synced)', t => {
    const { root, cleanup } = renderDot('green')
    try {
        const dot = root.querySelector('svg.dot')
        t.ok(dot?.classList.contains('green'), 'has the green modifier class')
    } finally {
        cleanup()
    }
})
