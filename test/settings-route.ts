import { test } from '@substrate-system/tapzero'
import { signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { SettingsRoute } from '../src/client/routes/settings.js'
import { type AppState, State } from '../src/client/state.js'
import {
    syncSubscriptions,
    pendingSyncSubscriptions,
    storeContent,
    defaultCacheMode,
    defaultMaxSizeBytes,
    defaultMaxAgeSeconds,
    loadLocalFirstSettings
} from '../src/client/local-first-settings.js'
import {
    billingStatus,
    resetBilling,
    type BillingStatus
} from '../src/client/billing-status.js'
import { localFirstSupported } from '../src/client/db/index.js'

interface MinimalState {
    isAuthenticated:ReturnType<typeof signal<boolean>>;
    user:ReturnType<typeof signal<null>>;
    feeds:ReturnType<typeof signal<[]>>;
    _setRoute:(r:string) => void;
    _routeHistory:string[];
}

type TestCheckBox = HTMLElement & {
    checked:boolean;
    disabled:boolean;
}

function makeState ():MinimalState {
    const history:string[] = []
    return {
        isAuthenticated: signal(true),
        user: signal(null),
        feeds: signal([]),
        _setRoute: (r:string) => { history.push(r) },
        _routeHistory: history
    }
}

function mount (state:MinimalState):HTMLElement {
    const root = document.createElement('div')
    document.body.appendChild(root)
    render(
        html`<${SettingsRoute} state=${state as unknown as AppState} />`,
        root
    )
    return root
}

function unmount (root:HTMLElement):void {
    render(null, root)
    root.remove()
}

function nextTick ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function entitledBilling ():BillingStatus {
    return {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
}

test('SettingsRoute applies queued local-first toggle after billing loads',
    async (t) => {
        const originalLoadBillingStatus = State.loadBillingStatus
        State.loadBillingStatus = async () => null
        resetBilling()
        localFirstSupported.value = true
        syncSubscriptions.value = false
        pendingSyncSubscriptions.value = false
        storeContent.value = false
        localStorage.removeItem('rsss.localFirst')

        const root = mount(makeState())
        try {
            await nextTick()
            const box = root.querySelector(
                'check-box[name="sync-subscriptions"]'
            ) as TestCheckBox|null
            t.ok(box, 'renders the sync subscriptions toggle')
            t.equal(box?.disabled, false,
                'toggle is usable while billing is loading')

            if (!box) return

            box.checked = true
            box.dispatchEvent(new Event('change', { bubbles: true }))
            await nextTick()

            t.equal(syncSubscriptions.value, false,
                'local-first is not enabled before billing resolves')
            t.equal(pendingSyncSubscriptions.value, true,
                'toggle intent is queued while billing loads')

            billingStatus.value = entitledBilling()
            await nextTick()

            t.equal(syncSubscriptions.value, true,
                'queued toggle applies when entitlement arrives')
        } finally {
            State.loadBillingStatus = originalLoadBillingStatus
            resetBilling()
            syncSubscriptions.value = false
            pendingSyncSubscriptions.value = false
            storeContent.value = false
            unmount(root)
        }
    }
)

test('SettingsRoute renders cache section after local-first section',
    async (t) => {
        localStorage.removeItem('rsss.localFirst')
        defaultCacheMode.value = 'text_images'
        defaultMaxSizeBytes.value = 50_000_000
        defaultMaxAgeSeconds.value = 30 * 86400

        const root = mount(makeState())
        try {
            await nextTick()
            const section = root.querySelector('.cache-section')
            t.ok(section, 'cache section is rendered')

            const sections = root.querySelectorAll('.settings-section')
            const sectionArr = Array.from(sections)
            const localFirstIdx = sectionArr.findIndex(
                s => s.classList.contains('local-first-section')
            )
            const cacheIdx = sectionArr.findIndex(
                s => s.classList.contains('cache-section')
            )
            const feedsIdx = sectionArr.findIndex(s =>
                s.querySelector('.settings-feeds-list') !== null
            )

            t.ok(
                cacheIdx > localFirstIdx,
                'cache section comes after local-first section'
            )
            t.ok(
                cacheIdx < feedsIdx,
                'cache section comes before feeds section'
            )
        } finally {
            unmount(root)
        }
    }
)

test('SettingsRoute cache section radio group reflects defaultCacheMode',
    async (t) => {
        localStorage.removeItem('rsss.localFirst')
        defaultCacheMode.value = 'text'

        const root = mount(makeState())
        try {
            await nextTick()
            const textRadio = root.querySelector(
                'input[name="default-cache-mode"][value="text"]'
            ) as HTMLInputElement|null
            const imagesRadio = root.querySelector(
                'input[name="default-cache-mode"][value="text_images"]'
            ) as HTMLInputElement|null

            t.ok(textRadio, 'text-only radio exists')
            t.ok(imagesRadio, 'text-and-images radio exists')
            t.ok(textRadio?.checked, 'text radio is checked when mode is text')
            t.ok(
                !imagesRadio?.checked,
                'images radio is not checked when mode is text'
            )
        } finally {
            defaultCacheMode.value = 'text_images'
            unmount(root)
        }
    }
)

test('SettingsRoute cache section radio change updates signal and saves',
    async (t) => {
        localStorage.removeItem('rsss.localFirst')
        defaultCacheMode.value = 'text_images'

        const root = mount(makeState())
        try {
            await nextTick()
            const textRadio = root.querySelector(
                'input[name="default-cache-mode"][value="text"]'
            ) as HTMLInputElement|null

            if (!textRadio) {
                t.fail('text radio not found')
                return
            }

            textRadio.checked = true
            textRadio.dispatchEvent(new Event('change', { bubbles: true }))
            await nextTick()

            t.equal(defaultCacheMode.value, 'text',
                'defaultCacheMode signal updated')

            loadLocalFirstSettings()
            t.equal(defaultCacheMode.value, 'text',
                'persisted value reloads as text')
        } finally {
            defaultCacheMode.value = 'text_images'
            localStorage.removeItem('rsss.localFirst')
            unmount(root)
        }
    }
)

test(
    'SettingsRoute cache section size input shows MB and updates signal',
    async (t) => {
        localStorage.removeItem('rsss.localFirst')
        defaultMaxSizeBytes.value = 50_000_000

        const root = mount(makeState())
        try {
            await nextTick()
            const input = root.querySelector(
                'input[name="default-max-size-mb"]'
            ) as HTMLInputElement|null
            t.ok(input, 'max size MB input exists')
            t.equal(input?.value, '50', 'displays 50 MB for 50_000_000 bytes')

            if (!input) return
            input.value = '10'
            input.dispatchEvent(new Event('change', { bubbles: true }))
            await nextTick()

            t.equal(defaultMaxSizeBytes.value, 10_000_000,
                'signal updated to 10 MB in bytes')
        } finally {
            defaultMaxSizeBytes.value = 50_000_000
            localStorage.removeItem('rsss.localFirst')
            unmount(root)
        }
    }
)

test(
    'SettingsRoute cache section age input shows days and updates signal',
    async (t) => {
        localStorage.removeItem('rsss.localFirst')
        defaultMaxAgeSeconds.value = 30 * 86400

        const root = mount(makeState())
        try {
            await nextTick()
            const input = root.querySelector(
                'input[name="default-max-age-days"]'
            ) as HTMLInputElement|null
            t.ok(input, 'max age days input exists')
            t.equal(input?.value, '30', 'displays 30 days for 30*86400 seconds')

            if (!input) return
            input.value = '7'
            input.dispatchEvent(new Event('change', { bubbles: true }))
            await nextTick()

            t.equal(defaultMaxAgeSeconds.value, 7 * 86400,
                'signal updated to 7 days in seconds')
        } finally {
            defaultMaxAgeSeconds.value = 30 * 86400
            localStorage.removeItem('rsss.localFirst')
            unmount(root)
        }
    }
)

test('SettingsRoute cache section save persists on change', async (t) => {
    localStorage.removeItem('rsss.localFirst')
    defaultMaxSizeBytes.value = 50_000_000

    const root = mount(makeState())
    try {
        await nextTick()
        const input = root.querySelector(
            'input[name="default-max-size-mb"]'
        ) as HTMLInputElement|null
        if (!input) {
            t.fail('input not found')
            return
        }
        input.value = '20'
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await nextTick()

        defaultMaxSizeBytes.value = 50_000_000
        loadLocalFirstSettings()
        t.equal(defaultMaxSizeBytes.value, 20_000_000,
            'value persisted to localStorage and reloads')
    } finally {
        defaultMaxSizeBytes.value = 50_000_000
        localStorage.removeItem('rsss.localFirst')
        unmount(root)
    }
})
