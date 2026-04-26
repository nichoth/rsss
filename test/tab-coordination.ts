import { test } from '@substrate-system/tapzero'
import {
    getLocalTabLockError,
    getTabCoordinationState,
    markLocalTabPrimary,
    markLocalTabReleased,
    resetTabCoordinationForTests,
    startTabCoordination
} from '../src/client/db/tab-coordination.js'

class FakeBroadcastChannel {
    static channels:FakeBroadcastChannel[] = []

    name:string
    onmessage:((ev:{ data:unknown }) => void)|null = null
    closed = false

    constructor (name:string) {
        this.name = name
        FakeBroadcastChannel.channels.push(this)
    }

    postMessage (data:unknown):void {
        for (const channel of FakeBroadcastChannel.channels) {
            if (channel === this || channel.name !== this.name) continue
            if (channel.closed) continue
            channel.onmessage?.({ data })
        }
    }

    close ():void {
        this.closed = true
    }

    static reset ():void {
        FakeBroadcastChannel.channels = []
    }
}

function setup () {
    FakeBroadcastChannel.reset()
    resetTabCoordinationForTests()
    Object.defineProperty(globalThis, 'BroadcastChannel', {
        value: FakeBroadcastChannel,
        configurable: true
    })
}

test('subsequent tab detects an existing primary tab', async (t) => {
    setup()
    const second = startTabCoordination()
    const primary = new FakeBroadcastChannel('rsss-tab')
    primary.postMessage({ type: 'primary' })
    await new Promise(resolve => setTimeout(resolve, 0))

    t.equal(
        getTabCoordinationState(),
        'blocked',
        'second tab is blocked from opening OPFS'
    )
    t.equal(
        getLocalTabLockError().value,
        'Local data is open in another tab',
        'lock message is surfaced for UI'
    )

    second.close()
    primary.close()
})

test('a waiting tab can promote after the primary releases', async (t) => {
    setup()
    const second = startTabCoordination()
    const primary = new FakeBroadcastChannel('rsss-tab')
    primary.postMessage({ type: 'primary' })
    await new Promise(resolve => setTimeout(resolve, 0))
    primary.postMessage({ type: 'released' })
    await new Promise(resolve => setTimeout(resolve, 0))

    t.equal(
        getTabCoordinationState(),
        'waiting',
        'released message clears blocked state'
    )
    t.equal(
        getLocalTabLockError().value,
        null,
        'released message clears UI error'
    )

    second.close()
    primary.close()
})

test('primary tabs announce availability and release', async (t) => {
    setup()
    const coordinator = startTabCoordination()
    const listener = new FakeBroadcastChannel('rsss-tab')
    const seen:unknown[] = []
    listener.onmessage = (ev) => seen.push(ev.data)

    markLocalTabPrimary()
    markLocalTabReleased()

    t.deepEqual(
        seen,
        [{ type: 'primary' }, { type: 'released' }],
        'primary and released messages are broadcast'
    )

    coordinator.close()
    listener.close()
})
