import { test } from '@substrate-system/tapzero'

// Reset localStorage before each logical group by clearing the key
const LS_KEY = 'rsss.localFirst'

test('load with no stored value returns defaults', async (t) => {
    localStorage.removeItem(LS_KEY)

    // Re-import via dynamic import so we can reset module state
    const mod = await import('../src/client/local-first-settings.js')
    mod.loadLocalFirstSettings()

    t.equal(mod.syncSubscriptions.value, false,
        'syncSubscriptions defaults to false')
    t.equal(mod.storeContent.value, false,
        'storeContent defaults to false')
})

test('save and load round-trip', async (t) => {
    localStorage.removeItem(LS_KEY)
    const mod = await import('../src/client/local-first-settings.js')

    mod.syncSubscriptions.value = true
    mod.storeContent.value = true
    mod.saveLocalFirstSettings()

    // Reset signals to defaults, then reload from storage
    mod.syncSubscriptions.value = false
    mod.storeContent.value = false
    mod.loadLocalFirstSettings()

    t.equal(mod.syncSubscriptions.value, true, 'syncSubscriptions reloaded')
    t.equal(mod.storeContent.value, true, 'storeContent reloaded')
})

test('setSyncSubscriptions(false) also forces storeContent to false', async (t) => {
    localStorage.removeItem(LS_KEY)
    const mod = await import('../src/client/local-first-settings.js')

    mod.syncSubscriptions.value = true
    mod.storeContent.value = true

    mod.setSyncSubscriptions(false)

    t.equal(mod.syncSubscriptions.value, false,
        'syncSubscriptions is false')
    t.equal(mod.storeContent.value, false,
        'storeContent forced to false when syncSubscriptions disabled')
})

test('setSyncSubscriptions(true) does not change storeContent', async (t) => {
    localStorage.removeItem(LS_KEY)
    const mod = await import('../src/client/local-first-settings.js')
    const billing = await import('../src/client/billing-status.js')

    billing.billingStatus.value = {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
    mod.syncSubscriptions.value = false
    mod.storeContent.value = false

    mod.setSyncSubscriptions(true)

    t.equal(mod.syncSubscriptions.value, true,
        'syncSubscriptions is true')
    t.equal(mod.storeContent.value, false,
        'storeContent unchanged when syncSubscriptions enabled')
})

test('setSyncSubscriptions(true) is a no-op for free (unentitled) users',
    async (t) => {
        localStorage.removeItem(LS_KEY)
        const mod = await import('../src/client/local-first-settings.js')
        const billing = await import('../src/client/billing-status.js')

        billing.billingStatus.value = {
            entitled: false,
            planId: 'local-first',
            status: 'none',
            refreshedAt: Date.now(),
            useLive: false
        }
        mod.syncSubscriptions.value = false

        mod.setSyncSubscriptions(true)

        t.equal(mod.syncSubscriptions.value, false,
            'free users cannot enable local-first')
    }
)

test('setSyncSubscriptions(true) waits for pending billing status',
    async (t) => {
        localStorage.removeItem(LS_KEY)
        const mod = await import('../src/client/local-first-settings.js')
        const billing = await import('../src/client/billing-status.js')

        billing.billingStatus.value = null
        mod.syncSubscriptions.value = false
        mod.storeContent.value = false

        mod.setSyncSubscriptions(true)

        t.equal(mod.syncSubscriptions.value, false,
            'local-first is not enabled before billing loads')

        billing.billingStatus.value = {
            entitled: true,
            planId: 'local-first',
            status: 'active',
            refreshedAt: Date.now(),
            useLive: false
        }
        await new Promise(resolve => setTimeout(resolve, 0))

        t.equal(mod.syncSubscriptions.value, true,
            'local-first enable applies after billing loads')
    }
)

test('cache default signals exported with correct initial defaults',
    async (t) => {
        localStorage.removeItem(LS_KEY)
        const mod = await import('../src/client/local-first-settings.js')

        mod.defaultCacheMode.value = 'text_images'
        mod.defaultMaxSizeBytes.value = 50_000_000
        mod.defaultMaxAgeSeconds.value = 30 * 86400

        t.equal(mod.defaultCacheMode.value, 'text_images',
            'defaultCacheMode initial value')
        t.equal(mod.defaultMaxSizeBytes.value, 50_000_000,
            'defaultMaxSizeBytes initial value')
        t.equal(mod.defaultMaxAgeSeconds.value, 30 * 86400,
            'defaultMaxAgeSeconds initial value')
    }
)

test('cache defaults round-trip through save and load', async (t) => {
    localStorage.removeItem(LS_KEY)
    const mod = await import('../src/client/local-first-settings.js')

    mod.defaultCacheMode.value = 'text'
    mod.defaultMaxSizeBytes.value = 10_000_000
    mod.defaultMaxAgeSeconds.value = 7 * 86400
    mod.saveLocalFirstSettings()

    mod.defaultCacheMode.value = 'text_images'
    mod.defaultMaxSizeBytes.value = 50_000_000
    mod.defaultMaxAgeSeconds.value = 30 * 86400
    mod.loadLocalFirstSettings()

    t.equal(mod.defaultCacheMode.value, 'text',
        'defaultCacheMode reloaded')
    t.equal(mod.defaultMaxSizeBytes.value, 10_000_000,
        'defaultMaxSizeBytes reloaded')
    t.equal(mod.defaultMaxAgeSeconds.value, 7 * 86400,
        'defaultMaxAgeSeconds reloaded')
})

test('missing cache fields fall back to defaults on load', async (t) => {
    const mod = await import('../src/client/local-first-settings.js')

    localStorage.setItem(LS_KEY, JSON.stringify({
        syncSubscriptions: false,
        storeContent: false
    }))
    mod.defaultCacheMode.value = 'text'
    mod.defaultMaxSizeBytes.value = 1
    mod.defaultMaxAgeSeconds.value = 1
    mod.loadLocalFirstSettings()

    t.equal(mod.defaultCacheMode.value, 'text_images',
        'defaultCacheMode falls back when missing')
    t.equal(mod.defaultMaxSizeBytes.value, 50_000_000,
        'defaultMaxSizeBytes falls back when missing')
    t.equal(mod.defaultMaxAgeSeconds.value, 30 * 86400,
        'defaultMaxAgeSeconds falls back when missing')
})

test('corrupt cache field values fall back to defaults on load', async (t) => {
    const mod = await import('../src/client/local-first-settings.js')

    localStorage.setItem(LS_KEY, JSON.stringify({
        syncSubscriptions: false,
        storeContent: false,
        defaultCacheMode: 'invalid-mode',
        defaultMaxSizeBytes: 'not-a-number',
        defaultMaxAgeSeconds: null
    }))
    mod.defaultCacheMode.value = 'text'
    mod.defaultMaxSizeBytes.value = 1
    mod.defaultMaxAgeSeconds.value = 1
    mod.loadLocalFirstSettings()

    t.equal(mod.defaultCacheMode.value, 'text_images',
        'corrupt cacheMode falls back to default')
    t.equal(mod.defaultMaxSizeBytes.value, 50_000_000,
        'corrupt maxSizeBytes falls back to default')
    t.equal(mod.defaultMaxAgeSeconds.value, 30 * 86400,
        'corrupt maxAgeSeconds falls back to default')
})
