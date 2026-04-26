import { html } from 'htm/preact'
import type { FunctionComponent } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { State, type AppState } from '../state.js'
import './payment-success.css'

type FinalizeState =
    | { kind:'pending' }
    | { kind:'success' }
    | { kind:'error'; message:string }

export const PaymentSuccessPage:FunctionComponent<{
    state:AppState
}> = function PaymentSuccessPage ({ state }) {
    const [status, setStatus] = useState<FinalizeState>(
        { kind: 'pending' }
    )

    useEffect(() => {
        let cancelled = false

        async function run () {
            // If we've come back from Autumn but the user isn't
            // authenticated (e.g. session expired), bounce to login.
            if (!state.isAuthenticated.value) {
                setStatus({
                    kind: 'error',
                    message: 'Please sign in to confirm your purchase.'
                })
                return
            }

            const result = await State.finalizeCheckout(state)
            if (cancelled) return

            if (result.ok) {
                setStatus({ kind: 'success' })
                // Brief pause so the user sees the success message,
                // then redirect home.
                setTimeout(() => {
                    if (!cancelled) state._setRoute('/')
                }, 1200)
            } else {
                // Retries exhausted -- ask the server to send the
                // "payment didn't go through" email (idempotent).
                State.signalCheckoutFailed().catch(() => {
                    // Best-effort; surface only the original error.
                })
                setStatus({
                    kind: 'error',
                    message: result.error ||
                        'Could not confirm payment'
                })
            }
        }

        run()

        return () => {
            cancelled = true
        }
    }, [])

    return html`
        <div class="route payment-success">
            <div class="payment-success-container">
                ${status.kind === 'pending' && html`
                    <div class="payment-pending">
                        <div class="loading-spinner"></div>
                        <h1>Confirming your subscription...</h1>
                        <p>
                            Hang tight -- this usually takes
                            a moment.
                        </p>
                    </div>
                `}

                ${status.kind === 'success' && html`
                    <div class="payment-confirmed">
                        <h1>You're all set</h1>
                        <p>
                            Your subscription is active. Redirecting
                            you to your feeds...
                        </p>
                    </div>
                `}

                ${status.kind === 'error' && html`
                    <div class="payment-error">
                        <h1>Something went wrong</h1>
                        <p class="error-message">
                            ${status.message}
                        </p>
                        <p>
                            If your card was charged, try refreshing
                            this page in a few seconds. Otherwise
                            you can
                            ${' '}<a
                                href="/signup"
                                onClick=${(e:Event) => {
                                    e.preventDefault()
                                    state._setRoute('/signup')
                                }}
                            >restart signup</a>.
                        </p>
                    </div>
                `}
            </div>
        </div>
    `
}
