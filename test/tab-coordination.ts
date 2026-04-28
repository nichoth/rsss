import { test } from '@substrate-system/tapzero'
import {
    acquireLocalTabLock,
    getLocalTabLockError,
    getTabCoordinationState,
    localTabLockRevision,
    markLocalTabPrimary,
    markLocalTabReleased,
    releaseLocalTabLock,
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

type LockCallback = (lock:{ name:string }) => unknown

class FakeLocks {
    held = new Set<string>()
    queues = new Map<string, LockCallback[]>()

    async request (
        name:string,
        options:LockOptions,
        callback:LockCallback
    ):Promise<unknown> {
        if (options.ifAvailable) {
            if (this.held.has(name)) return callback(null as never)
            this.held.add(name)
            return Promise.resolve(callback({ name })).finally(() => {
                this.release(name)
            })
        }

        if (this.held.has(name)) {
            return new Promise((resolve, reject) => {
                const run = (lock:{ name:string }) => {
                    Promise.resolve(callback(lock)).then(resolve, reject)
                }
                const queue = this.queues.get(name) ?? []
                queue.push(run)
                this.queues.set(name, queue)
            })
        }

        this.held.add(name)
        return Promise.resolve(callback({ name })).finally(() => {
            this.release(name)
        })
    }

    release (name:string):void {
        const queue = this.queues.get(name) ?? []
        const next = queue.shift()
        if (queue.length === 0) this.queues.delete(name)
        if (next) {
            next({ name })
            return
        }
        this.held.delete(name)
    }
}

function setup () {
    FakeBroadcastChannel.reset()
    resetTabCoordinationForTests()
    Object.defineProperty(globalThis, 'BroadcastChannel', {
        value: FakeBroadcastChannel,
        configurable: true
    })
    Object.defineProperty(navigator, 'locks', {
        value: undefined,
        configurable: true
    })
}

function setupLocks ():FakeLocks {
    const locks = new FakeLocks()
    Object.defineProperty(navigator, 'locks', {
        value: locks,
        configurable: true
    })
    return locks
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
    const before = localTabLockRevision.value

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
    t.equal(
        localTabLockRevision.value,
        before + 2,
        'primary and released transitions bump the render signal'
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

test('tab coordination acquires and holds a Web Lock', async (t) => {
    setup()
    const locks = setupLocks()
    const acquired = await acquireLocalTabLock()

    t.equal(acquired, true, 'first tab acquires the Web Lock')
    t.equal(
        getTabCoordinationState(),
        'primary',
        'acquired lock marks the tab primary'
    )

    let secondAcquired = false
    navigator.locks.request(
        'rsss-opfs',
        { ifAvailable: true, mode: 'exclusive' },
        (lock) => {
            secondAcquired = Boolean(lock)
        }
    )

    t.equal(secondAcquired, false, 'the lock stays held after acquisition')
    releaseLocalTabLock()
    await new Promise(resolve => setTimeout(resolve, 0))
    t.equal(locks.held.has('rsss-opfs'), false, 'release frees the lock')
})

test('blocked tab can acquire after an ungraceful primary exit', async (t) => {
    setup()
    const locks = setupLocks()
    locks.held.add('rsss-opfs')

    const acquired = await acquireLocalTabLock()
    t.equal(acquired, false, 'tab is blocked while another tab owns the lock')
    t.equal(
        getLocalTabLockError().value,
        'Local data is open in another tab',
        'blocked lock state is surfaced'
    )

    const promoted = acquireLocalTabLock()
    locks.release('rsss-opfs')

    t.equal(await promoted, true, 'waiting tab promotes without page refresh')
    t.equal(
        getTabCoordinationState(),
        'primary',
        'promoted tab becomes primary'
    )

    releaseLocalTabLock()
})
