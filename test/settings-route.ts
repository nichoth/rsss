import { test } from '@substrate-system/tapzero'
import { signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { SettingsRoute } from '../src/client/routes/settings.js'
import { type AppState, State } from '../src/client/state.js'
import {
    syncSubscriptions,
    pendingSyncSubscriptions,
    storeContent
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
