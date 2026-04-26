import { test } from '@substrate-system/tapzero'
import { syncSubscriptions } from '../src/client/local-first-settings.js'
import {
    isLocalFirstSupported,
    getAdapter,
    getBootstrappedDb,
    _resetSupportedCache,
    _resetAdapterCache
} from '../src/client/db/index.js'
import { remoteAdapter } from '../src/client/db/remote-adapter.js'
import {
    resetTabCoordinationForTests,
    setLocalTabBlocked
} from '../src/client/db/tab-coordination.js'

function setup () {
    syncSubscriptions.value = false
    _resetSupportedCache()
    _resetAdapterCache()
    resetTabCoordinationForTests()
}

test('isLocalFirstSupported returns false when navigator.storage missing',
    (t) => {
        setup()
        const origStorage = navigator.storage
        Object.defineProperty(navigator, 'storage', {
            value: undefined, configurable: true
        })
        const result = isLocalFirstSupported()
        t.equal(result, false, 'returns false without navigator.storage')
        Object.defineProperty(navigator, 'storage', {
            value: origStorage, configurable: true
        })
    }
)

test('isLocalFirstSupported caches result for session', (t) => {
    setup()
    const first = isLocalFirstSupported()
    const second = isLocalFirstSupported()
    t.equal(first, second, 'both calls return same cached value')
})

test('getAdapter returns remoteAdapter when syncSubscriptions is false',
    async (t) => {
        setup()
        syncSubscriptions.value = false
        const adapter = await getAdapter('did:plc:test')
        t.equal(adapter, remoteAdapter,
            'returns remoteAdapter when opt-in off')
    }
)

test('getAdapter returns remoteAdapter when opted in but support missing',
    async (t) => {
        setup()
        syncSubscriptions.value = true
        // Force support check to false by clearing cache and stubbing storage
        const origStorage = navigator.storage
        Object.defineProperty(navigator, 'storage', {
            value: undefined, configurable: true
        })
        _resetSupportedCache()
        const adapter = await getAdapter('did:plc:test')
        t.equal(adapter, remoteAdapter,
            'returns remoteAdapter when OPFS not supported')
        Object.defineProperty(navigator, 'storage', {
            value: origStorage, configurable: true
        })
    }
)

test('getAdapter returns remoteAdapter when did is absent', async (t) => {
    setup()
    syncSubscriptions.value = true
    // Even if support were true, no did means no local DB to open
    const adapter = await getAdapter(undefined)
    t.equal(adapter, remoteAdapter, 'returns remoteAdapter when did missing')
})

test('getAdapter returns remoteAdapter when another tab owns OPFS',
    async (t) => {
        setup()
        syncSubscriptions.value = true
        Object.defineProperty(navigator, 'storage', {
            value: { getDirectory: () => Promise.resolve({}) },
            configurable: true
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            value: true,
            configurable: true
        })
        Object.defineProperty(globalThis, 'FileSystemSyncAccessHandle', {
            value: function FileSystemSyncAccessHandle () {},
            configurable: true
        })
        setLocalTabBlocked()

        const adapter = await getAdapter('did:plc:test')

        t.equal(adapter, remoteAdapter,
            'falls back to remoteAdapter when tab lock is blocked')
    }
)

test('db barrel exports bootstrap DB accessor', (t) => {
    t.equal(
        typeof getBootstrappedDb,
        'function',
        'getBootstrappedDb is available from db/index'
    )
})
