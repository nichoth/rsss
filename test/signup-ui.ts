/**
 * Browser-side render tests for the SignupPage. Mounts the real
 * Preact component against jsdom-like DOM provided by tapout/Chromium
 * and exercises the user-visible interactions.
 */
import { test } from '@substrate-system/tapzero'
import { signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { SignupPage } from '../src/client/routes/signup.js'
import { type AppState } from '../src/client/state.js'
import {
    billingStatus,
    billingError,
    checkoutInProgress,
    resetBilling
} from '../src/client/billing-status.js'

interface MinimalState {
    isAuthenticated:ReturnType<typeof signal<boolean>>;
    authLoading:ReturnType<typeof signal<boolean>>;
    user:ReturnType<typeof signal<unknown>>;
    route:ReturnType<typeof signal<string>>;
    routes:Array<unknown>;
    _setRoute:(r:string) => void;
    _routeHistory:string[];
}

function makeState (
    opts:{ authed?:boolean; authLoading?:boolean } = {}
):MinimalState {
    const history:string[] = []
    return {
        isAuthenticated: signal(Boolean(opts.authed)),
        authLoading: signal(Boolean(opts.authLoading)),
        user: signal(null),
        route: signal('/signup'),
        routes: [],
        _setRoute: (r:string) => { history.push(r) },
        _routeHistory: history
    }
}

function mount (state:MinimalState):HTMLElement {
    const root = document.createElement('div')
    document.body.appendChild(root)
    render(
        html`<${SignupPage} state=${state as unknown as AppState} />`,
        root
    )
    return root
}

function unmount (root:HTMLElement):void {
    render(null, root)
    root.remove()
    resetBilling()
}

test('SignupPage renders both plan cards when not entitled', t => {
    const state = makeState({ authed: false })
    const root = mount(state)
    try {
        const cards = root.querySelectorAll('.plan-card')
        t.equal(cards.length, 2, 'renders two plan cards')

        const free = root.querySelector('.plan-free')
        t.ok(free, 'renders the Free plan card')
        const sync = root.querySelector('.plan-sync')
        t.ok(sync, 'renders the Local-first plan card')

        const headings = Array.from(
            root.querySelectorAll('.plan-card h2')
        ).map(h => h.textContent?.trim())
        t.ok(headings.includes('Free'), 'shows Free heading')
        t.ok(
            headings.includes('Local-first'),
            'shows Local-first heading'
        )
    } finally {
        unmount(root)
    }
})

test(
    'SignupPage Free button label depends on auth state',
    t => {
        const guest = makeState({ authed: false })
        const guestRoot = mount(guest)
        try {
            const btn = guestRoot.querySelector(
                '.plan-free button'
            ) as HTMLButtonElement
            t.equal(
                btn.textContent?.trim(),
                'Get started',
                'guest sees Get started'
            )
        } finally {
            unmount(guestRoot)
        }

        const authed = makeState({ authed: true })
        const authedRoot = mount(authed)
        try {
            const btn = authedRoot.querySelector(
                '.plan-free button'
            ) as HTMLButtonElement
            t.equal(
                btn.textContent?.trim(),
                'Continue with Free',
                'authed user sees Continue with Free'
            )
        } finally {
            unmount(authedRoot)
        }
    }
)

test(
    'SignupPage Subscribe button is disabled until valid email',
    async t => {
        const state = makeState({ authed: true })
        const root = mount(state)
        try {
            const btn = root.querySelector(
                '.plan-sync button.btn-primary'
            ) as HTMLButtonElement
            t.equal(
                btn.disabled,
                true,
                'disabled before email is entered'
            )

            const input = root.querySelector(
                '#signup-email'
            ) as HTMLInputElement
            t.ok(input, 'renders the email input when authed')

            // Bad email keeps button disabled.
            input.value = 'not-an-email'
            input.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 0))
            const stillDisabled = (root.querySelector(
                '.plan-sync button.btn-primary'
            ) as HTMLButtonElement).disabled
            t.equal(
                stillDisabled,
                true,
                'still disabled with invalid email'
            )

            // Good email enables.
            input.value = 'alice@example.com'
            input.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(resolve => setTimeout(resolve, 0))
            const enabled = !(root.querySelector(
                '.plan-sync button.btn-primary'
            ) as HTMLButtonElement).disabled
            t.equal(
                enabled,
                true,
                'enabled once a valid email is entered'
            )
        } finally {
            unmount(root)
        }
    }
)

test(
    'SignupPage Subscribe (not authed) routes the user to /login',
    t => {
        const state = makeState({ authed: false })
        const root = mount(state)
        try {
            const btn = root.querySelector(
                '.plan-sync button.btn-primary'
            ) as HTMLButtonElement
            t.equal(
                btn.textContent?.trim(),
                'Sign in & subscribe',
                'shows Sign in & subscribe label'
            )
            btn.click()
            t.deepEqual(
                state._routeHistory,
                ['/login'],
                'navigates to /login'
            )
        } finally {
            unmount(root)
        }
    }
)

test(
    'SignupPage Free button (not authed) routes the user to /login',
    t => {
        const state = makeState({ authed: false })
        const root = mount(state)
        try {
            const btn = root.querySelector(
                '.plan-free button'
            ) as HTMLButtonElement
            btn.click()
            t.deepEqual(
                state._routeHistory,
                ['/login'],
                'navigates to /login'
            )
        } finally {
            unmount(root)
        }
    }
)

test(
    'SignupPage Free button (authed) routes the user home',
    t => {
        const state = makeState({ authed: true })
        const root = mount(state)
        try {
            const btn = root.querySelector(
                '.plan-free button'
            ) as HTMLButtonElement
            btn.click()
            t.deepEqual(
                state._routeHistory,
                ['/'],
                'navigates to /'
            )
        } finally {
            unmount(root)
        }
    }
)

test(
    'SignupPage shows the entitled state when billing.entitled=true',
    t => {
        const state = makeState({ authed: true })
        billingStatus.value = {
            entitled: true,
            planId: 'local-first',
            status: 'active',
            refreshedAt: Date.now(),
            useLive: false
        }
        const root = mount(state)
        try {
            const already = root.querySelector('.signup-already')
            t.ok(already, 'renders the entitled section')
            const heading = root.querySelector('.signup-already h2')
            t.equal(
                heading?.textContent?.trim(),
                "You're subscribed",
                "shows You're subscribed heading"
            )
            const planCards = root.querySelectorAll('.plan-card')
            t.equal(
                planCards.length,
                0,
                'plan cards are hidden when entitled'
            )
        } finally {
            unmount(root)
        }
    }
)

test(
    'SignupPage surfaces billing errors at the top of the page',
    t => {
        const state = makeState({ authed: true })
        billingError.value = 'Network error: please retry'
        const root = mount(state)
        try {
            const err = root.querySelector('.error-message')
            t.ok(err, 'renders the error banner')
            t.equal(
                err?.textContent?.trim(),
                'Network error: please retry',
                'error banner shows the message'
            )
        } finally {
            unmount(root)
        }
    }
)

test(
    'SignupPage Subscribe button reflects checkoutInProgress state',
    t => {
        const state = makeState({ authed: true })
        checkoutInProgress.value = true
        const root = mount(state)
        try {
            const btn = root.querySelector(
                '.plan-sync button.btn-primary'
            ) as HTMLButtonElement
            t.equal(
                btn.textContent?.trim(),
                'Starting checkout...',
                'shows in-flight label'
            )
            t.equal(btn.disabled, true, 'is disabled while in flight')
        } finally {
            unmount(root)
        }
    }
)
