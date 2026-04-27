import { test } from '@substrate-system/tapzero'
import { syncSubscriptions } from '../src/client/local-first-settings.js'
import { billingStatus } from '../src/client/billing-status.js'
import {
    isLocalFirstSupported,
    getAdapter,
    getBootstrappedDb,
    localDbError,
    _resetSupportedCache,
    _resetAdapterCache
} from '../src/client/db/index.js'
import { remoteAdapter } from '../src/client/db/remote-adapter.js'
import {
    resetTabCoordinationForTests,
    setLocalTabBlocked
} from '../src/client/db/tab-coordination.js'
import {
    setSQLiteWorkerClientFactoryForTests,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import type {
    SQLiteWorkerClient
} from '../src/client/db/sqlite-worker-client.js'

function setup () {
    syncSubscriptions.value = false
    billingStatus.value = {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
    localDbError.value = null
    _resetSupportedCache()
    _resetAdapterCache()
    resetTabCoordinationForTests()
    setSQLiteWorkerClientFactoryForTests(null)
}

test('isLocalFirstSupported returns false when navigator.storage missing',
    async (t) => {
        setup()
        const origStorage = navigator.storage
        Object.defineProperty(navigator, 'storage', {
            value: undefined, configurable: true
        })
        const result = await isLocalFirstSupported()
        t.equal(result, false, 'returns false without navigator.storage')
        Object.defineProperty(navigator, 'storage', {
            value: origStorage, configurable: true
        })
    }
)

test('isLocalFirstSupported asks the SQLite worker before returning true',
    async (t) => {
        setup()
        const origStorage = navigator.storage
        const previousIsolated = (
            globalThis as { crossOriginIsolated?:boolean }
        ).crossOriginIsolated
        const previousAccessHandle = (
            globalThis as Record<string, unknown>
        ).FileSystemSyncAccessHandle
        let probes = 0

        Object.defineProperty(navigator, 'storage', {
            value: { getDirectory: async () => ({}) },
            configurable: true
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            value: true,
            configurable: true
        })
        ;(globalThis as Record<string, unknown>)
            .FileSystemSyncAccessHandle = undefined
        setSQLiteWorkerClientFactoryForTests(() => ({
            probe: async () => {
                probes++
            },
            dispose: () => {}
        } as unknown as SQLiteWorkerClient))

        try {
            const result = await isLocalFirstSupported()

            t.equal(result, true, 'returns true when the worker probe passes')
            t.equal(probes, 1, 'consults the SQLite worker')
        } finally {
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            })
            Object.defineProperty(globalThis, 'crossOriginIsolated', {
                value: previousIsolated,
                configurable: true
            })
            ;(globalThis as Record<string, unknown>)
                .FileSystemSyncAccessHandle = previousAccessHandle
            setSQLiteWorkerClientFactoryForTests(null)
        }
    }
)

test('isLocalFirstSupported caches result for session', async (t) => {
    setup()
    const first = await isLocalFirstSupported()
    const second = await isLocalFirstSupported()
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

test('getAdapter returns remoteAdapter when worker OPFS probe fails',
    async (t) => {
        setup()
        syncSubscriptions.value = true
        const origStorage = navigator.storage
        const previousIsolated = (
            globalThis as { crossOriginIsolated?:boolean }
        ).crossOriginIsolated
        let probes = 0

        Object.defineProperty(navigator, 'storage', {
            value: { getDirectory: async () => ({}) },
            configurable: true
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            value: true,
            configurable: true
        })
        setSQLiteWorkerClientFactoryForTests(() => ({
            probe: async () => {
                probes++
                throw new Error('OPFS VFS unavailable in worker')
            },
            dispose: () => {}
        } as unknown as SQLiteWorkerClient))

        try {
            const adapter = await getAdapter('did:plc:test')

            t.equal(adapter, remoteAdapter,
                'returns remoteAdapter when worker probe fails')
            t.equal(probes, 1, 'probes OPFS support in the worker')
        } finally {
            Object.defineProperty(navigator, 'storage', {
                value: origStorage,
                configurable: true
            })
            Object.defineProperty(globalThis, 'crossOriginIsolated', {
                value: previousIsolated,
                configurable: true
            })
            setSQLiteWorkerClientFactoryForTests(null)
        }
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
        setSQLiteWorkerClientFactoryForTests(() => ({
            probe: async () => {},
            dispose: () => {}
        } as unknown as SQLiteWorkerClient))
        setLocalTabBlocked()

        const adapter = await getAdapter('did:plc:test')

        t.equal(adapter, remoteAdapter,
            'falls back to remoteAdapter when tab lock is blocked')
    }
)

test('getAdapter reports quota open failures instead of silent fallback',
    async (t) => {
        setup()
        syncSubscriptions.value = true
        Object.defineProperty(navigator, 'storage', {
            value: { getDirectory: async () => ({}) },
            configurable: true
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            value: true,
            configurable: true
        })
        setTestMode(false)
        setSQLiteWorkerClientFactoryForTests(() => ({
            probe: async () => {},
            open: async () => {
                throw new DOMException(
                    'The quota has been exceeded.',
                    'QuotaExceededError'
                )
            },
            dispose: () => {}
        } as unknown as SQLiteWorkerClient))

        try {
            const adapter = await getAdapter('did:plc:quota')

            t.equal(adapter, remoteAdapter,
                'keeps the app usable through the remote adapter')
            t.equal(localDbError.value?.category, 'quota',
                'records the quota category for Settings')
            t.ok(
                /free up space/i.test(localDbError.value?.message ?? ''),
                'message tells the user how to recover'
            )
            t.equal(localDbError.value?.canReset, false,
                'quota errors do not suggest reset as the primary fix')
        } finally {
            setTestMode(true)
            setSQLiteWorkerClientFactoryForTests(null)
        }
    }
)

test('getAdapter reports corrupt open failures as resettable',
    async (t) => {
        setup()
        syncSubscriptions.value = true
        Object.defineProperty(navigator, 'storage', {
            value: { getDirectory: async () => ({}) },
            configurable: true
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            value: true,
            configurable: true
        })
        setTestMode(false)
        setSQLiteWorkerClientFactoryForTests(() => ({
            probe: async () => {},
            open: async () => {
                throw new Error('database disk image is malformed')
            },
            dispose: () => {}
        } as unknown as SQLiteWorkerClient))

        try {
            const adapter = await getAdapter('did:plc:corrupt')

            t.equal(adapter, remoteAdapter,
                'keeps the app usable through the remote adapter')
            t.equal(localDbError.value?.category, 'corruption',
                'records the corruption category for Settings')
            t.equal(localDbError.value?.canReset, true,
                'corrupt databases expose reset recovery')
        } finally {
            setTestMode(true)
            setSQLiteWorkerClientFactoryForTests(null)
        }
    }
)

test('getAdapter returns remoteAdapter for free (unentitled) users',
    async (t) => {
        setup()
        syncSubscriptions.value = true
        billingStatus.value = {
            entitled: false,
            planId: 'local-first',
            status: 'none',
            refreshedAt: Date.now(),
            useLive: false
        }
        const adapter = await getAdapter('did:plc:test')
        t.equal(adapter, remoteAdapter,
            'free users get remoteAdapter even with the toggle on')
    }
)

test('getAdapter returns remoteAdapter when billingStatus is null',
    async (t) => {
        setup()
        syncSubscriptions.value = true
        billingStatus.value = null
        const adapter = await getAdapter('did:plc:test')
        t.equal(adapter, remoteAdapter,
            'unloaded billing falls back to remoteAdapter')
    }
)

test('db barrel exports bootstrap DB accessor', (t) => {
    t.equal(
        typeof getBootstrappedDb,
        'function',
        'getBootstrappedDb is available from db/index'
    )
})
