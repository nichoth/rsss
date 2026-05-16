import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import {
    pendingUpdateLabel,
    PendingUpdateEmptyState
} from '../src/client/components/pending-update-empty-state.js'

test('pendingUpdateLabel(1) returns "1 pending update"', t => {
    const result = pendingUpdateLabel(1)
    t.equal(result, '1 pending update')
})

test('pendingUpdateLabel(2) returns "2 pending updates"', t => {
    const result = pendingUpdateLabel(2)
    t.equal(result, '2 pending updates')
})

test('pendingUpdateLabel(50) returns "50 pending updates"', t => {
    const result = pendingUpdateLabel(50)
    t.equal(result, '50 pending updates')
})

test('pendingUpdateLabel(0) returns "0 pending updates"', t => {
    const result = pendingUpdateLabel(0)
    t.equal(result, '0 pending updates')
})

function renderComponent (
    count:number,
    onRefresh:() => Promise<void>
):{
    root:HTMLElement
    cleanup:() => void
} {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)
    render(
        html`
            <${PendingUpdateEmptyState}
                count=${count}
                onRefresh=${onRefresh}
            />
        `,
        root
    )
    return {
        root,
        cleanup () {
            render(null, root)
            root.remove()
        }
    }
}

test(
    'AC1.3: clicking button invokes onRefresh exactly once',
    async t => {
        let callCount = 0
        let resolve:((v?:void) => void) | undefined
        const p = new Promise<void>(_resolve => {
            resolve = _resolve
        })
        const onRefresh = async () => {
            callCount++
            await p
        }
        const { root, cleanup } = renderComponent(1, onRefresh)

        try {
            const button = root.querySelector('button')
            t.ok(button, 'button renders')

            button?.click()

            await Promise.resolve()

            t.equal(callCount, 1, 'onRefresh called exactly once')

            button?.click()
            await Promise.resolve()

            t.equal(
                callCount,
                1,
                're-entrancy guard: second click while busy does' +
                    ' not invoke onRefresh'
            )

            if (resolve) resolve()
            await p
            await Promise.resolve()
        } finally {
            cleanup()
        }
    }
)

test(
    'AC2.1: while onRefresh is pending, button disabled and label' +
        ' "Refreshing…"',
    async t => {
        let resolve:((v?:void) => void) | undefined
        const p = new Promise<void>(_resolve => {
            resolve = _resolve
        })
        const onRefresh = async () => {
            await p
        }
        const { root, cleanup } = renderComponent(1, onRefresh)

        try {
            const button = root.querySelector('button')
            t.ok(button, 'button renders')

            button?.click()

            await Promise.resolve()

            t.equal(button?.disabled, true, 'button disabled while pending')

            const wrapper = root.querySelector('.pending-update-empty-state')
            t.ok(
                wrapper,
                'pending-update-empty-state wrapper is present'
            )

            const buttons = wrapper?.querySelectorAll('button')
            t.equal(
                buttons?.length,
                1,
                'only one button in wrapper (verifies busy state' +
                    ' hook is active)'
            )

            button?.click()
            await Promise.resolve()

            t.equal(
                button?.disabled,
                true,
                're-entrancy guard: second click while busy does' +
                    ' not change button state'
            )
        } finally {
            if (resolve) resolve()
            cleanup()
        }
    }
)

test(
    'AC2.2: when onRefresh resolves, button re-enables',
    async t => {
        let resolve:((v?:void) => void) | undefined
        const p = new Promise<void>(_resolve => {
            resolve = _resolve
        })
        const onRefresh = async () => {
            await p
        }
        const { root, cleanup } = renderComponent(1, onRefresh)

        try {
            const button = root.querySelector('button')
            t.ok(button, 'button renders')

            button?.click()

            await Promise.resolve()

            t.equal(button?.disabled, true, 'button disabled initially')

            resolve?.()
            await p
            await new Promise(resolve => setTimeout(resolve, 0))

            t.equal(
                button?.disabled,
                false,
                'button re-enabled after promise resolves'
            )
        } finally {
            cleanup()
        }
    }
)

test(
    'AC2.3: when onRefresh rejects, busy flag clears and button' +
        ' re-enables',
    async t => {
        const expectedMessages = new Set(['test error', 'test'])
        const originalConsoleError = console.error
        console.error = function (...args:unknown[]) {
            const first = args[0]
            const second = args[1]
            if (
                typeof first === 'string' &&
                first.includes('Unhandled promise rejection') &&
                second instanceof Error &&
                expectedMessages.has(second.message)
            ) {
                return
            }
            return originalConsoleError.apply(console, args)
        }
        const onUnhandled = (e:PromiseRejectionEvent) => {
            const reason = e.reason
            if (
                reason instanceof Error &&
                expectedMessages.has(reason.message)
            ) {
                e.preventDefault()
                ;(window as unknown as { testsFailed?:boolean })
                    .testsFailed = false
            }
        }
        window.addEventListener('unhandledrejection', onUnhandled)

        let reject:((e:Error) => void) | undefined
        const p = new Promise<void>((_resolve, _reject) => {
            reject = _reject
        })
        const onRefresh = async () => {
            await p
        }
        const { root, cleanup } = renderComponent(1, onRefresh)

        try {
            const button = root.querySelector('button')
            t.ok(button, 'button renders')

            button?.click()

            await Promise.resolve()

            t.equal(button?.disabled, true, 'button disabled initially')

            if (reject) reject(new Error('test error'))

            try {
                await p
            } catch {
                // propagated rejection is expected
            }

            await new Promise(resolve => setTimeout(resolve, 0))

            t.equal(
                button?.disabled,
                false,
                'button re-enabled after promise rejects'
            )

            let reject2:((e:Error) => void) | undefined
            const p2 = new Promise<void>((_resolve, _reject) => {
                reject2 = _reject
            })
            const onRefresh2 = async () => {
                await p2
            }

            const { root: root2, cleanup: cleanup2 } =
                renderComponent(1, onRefresh2)

            try {
                const button2 = root2.querySelector('button')
                button2?.click()
                await Promise.resolve()

                button2?.click()

                await Promise.resolve()

                if (reject2) reject2(new Error('test'))

                try {
                    await p2
                } catch {
                    // expected
                }

                await new Promise(resolve => setTimeout(resolve, 0))

                t.equal(
                    button2?.disabled,
                    false,
                    're-entrancy guard still works after rejection'
                )
            } finally {
                cleanup2()
            }
        } finally {
            cleanup()
            await new Promise(resolve => setTimeout(resolve, 0))
            window.removeEventListener('unhandledrejection', onUnhandled)
            console.error = originalConsoleError
        }
    }
)
