import { html } from 'htm/preact'
import type { FunctionComponent } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { State, type AppState } from '../state.js'
import {
    billingStatus,
    billingError as billingErrorSignal,
    checkoutInProgress
} from '../billing-status.js'
import './signup.css'

const EMAIL_RE = /.+@.+\..+/

export const SignupPage:FunctionComponent<{
    state:AppState
}> = function SignupPage ({ state }) {
    const authLoading = useComputed(() => state.authLoading.value)
    const isAuthed = useComputed(() => state.isAuthenticated.value)
    const billing = useComputed(() => billingStatus.value)
    const billingError = useComputed(() => billingErrorSignal.value)
    const inProgress = useComputed(
        () => checkoutInProgress.value
    )
    const [email, setEmail] = useState('')
    const emailValid = EMAIL_RE.test(email.trim())

    // Refresh billing status when this page mounts so the
    // "you're already subscribed" branch is accurate.
    useEffect(() => {
        if (state.isAuthenticated.value) {
            State.loadBillingStatus(state)
        }
    }, [])

    const entitled = Boolean(billing.value?.entitled)

    function handleFree (e:Event) {
        e.preventDefault()
        if (state.isAuthenticated.value) {
            state._setRoute('/')
        } else {
            state._setRoute('/login')
        }
    }

    async function handleSync (e:Event) {
        e.preventDefault()
        if (!state.isAuthenticated.value) {
            // Send to login first; on return the user lands at `/`,
            // and they can re-visit `/signup` to continue.
            state._setRoute('/login')
            return
        }
        if (!emailValid) return
        await State.startCheckout(
            state,
            'sync',
            email.trim()
        )
    }

    function handleManage (e:Event) {
        e.preventDefault()
        State.openCustomerPortal(state)
    }

    return html`
        <div class="route signup">
            <div class="signup-container">
                <header class="signup-header">
                    <h1>Choose a plan</h1>
                    <p>
                        RSSS is free to use on a single device. To
                        sync your feeds, read state, and starred
                        items across machines, subscribe to Sync.
                    </p>
                </header>

                ${(billingError.value) && html`
                    <div class="error-message">
                        ${billingError.value}
                    </div>
                `}

                ${entitled && html`
                    <div class="signup-already">
                        <h2>You're subscribed</h2>
                        <p>
                            You're on the
                            <strong>${billing.value?.planId}</strong>
                            plan.
                        </p>
                        <button
                            type="button"
                            class="btn btn-primary"
                            onClick=${handleManage}
                        >
                            Manage subscription
                        </button>
                        <p class="signup-secondary">
                            <a href="/" onClick=${(e:Event) => {
                                e.preventDefault()
                                state._setRoute('/')
                            }}>Back to feeds</a>
                        </p>
                    </div>
                `}

                ${!entitled && html`
                    <div class="signup-plans">
                        <article class="plan-card plan-free">
                            <h2>Free</h2>
                            <p class="plan-price">$0</p>
                            <ul class="plan-features">
                                <li>Use on one device</li>
                                <li>Local storage in your browser</li>
                                <li>Works offline</li>
                            </ul>
                            <button
                                type="button"
                                class="btn btn-secondary"
                                onClick=${handleFree}
                                disabled=${authLoading.value}
                            >
                                ${isAuthed.value ?
                                    'Continue with Free' :
                                    'Get started'}
                            </button>
                        </article>

                        <article class="plan-card plan-sync">
                            <h2>Sync</h2>
                            <p class="plan-price">
                                $10
                                <span class="plan-period">/month</span>
                            </p>
                            <ul class="plan-features">
                                <li>Everything in Free</li>
                                <li>Sync across all your devices</li>
                                <li>Server-side feed polling</li>
                            </ul>
                            ${isAuthed.value && html`
                                <div class="plan-email">
                                    <label for="signup-email">
                                        Email
                                    </label>
                                    <input
                                        type="email"
                                        id="signup-email"
                                        name="email"
                                        autocomplete="email"
                                        placeholder="you@example.com"
                                        value=${email}
                                        onInput=${(e:Event) => {
                                            const v = (
                                                e.target as
                                                HTMLInputElement
                                            ).value
                                            setEmail(v)
                                        }}
                                        disabled=${
                                            inProgress.value
                                        }
                                        required
                                    />
                                    <p class="plan-email-help">
                                        Used for receipts and
                                        subscription updates.
                                    </p>
                                </div>
                            `}
                            <button
                                type="button"
                                class="btn btn-primary"
                                onClick=${handleSync}
                                disabled=${inProgress.value ||
                                    authLoading.value ||
                                    (isAuthed.value && !emailValid)}
                            >
                                ${inProgress.value ?
                                    'Starting checkout...' :
                                    isAuthed.value ?
                                        'Subscribe' :
                                        'Sign in & subscribe'}
                            </button>
                        </article>
                    </div>
                `}
            </div>
        </div>
    `
}
