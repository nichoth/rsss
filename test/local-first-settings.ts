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

    mod.syncSubscriptions.value = false
    mod.storeContent.value = false

    mod.setSyncSubscriptions(true)

    t.equal(mod.syncSubscriptions.value, true,
        'syncSubscriptions is true')
    t.equal(mod.storeContent.value, false,
        'storeContent unchanged when syncSubscriptions enabled')
})
