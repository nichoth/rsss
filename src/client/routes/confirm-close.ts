import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useState } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { type AppState, State } from '../state.js'
import { billingStatus } from '../billing-status.js'
import './confirm-close.css'

const AUTO_LOGOUT_DELAY_MS = 2500

type Status =
    | { kind:'idle' }
    | { kind:'submitting' }
    | { kind:'scheduled'; scheduledFor:number }
    | { kind:'error'; message:string }

function formatDate (ms:number):string {
    return new Date(ms).toLocaleString()
}

export const ConfirmCloseRoute:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const [status, setStatus] = useState<Status>({ kind: 'idle' })
    const billing = useComputed(() => billingStatus.value)
    const isEntitled = Boolean(billing.value?.entitled)

    async function handleConfirm (e:Event) {
        e.preventDefault()
        if (status.kind === 'submitting') return
        setStatus({ kind: 'submitting' })

        try {
            const result = await State.scheduleAccountDeletion()
            setStatus({
                kind: 'scheduled',
                scheduledFor: result.scheduledFor
            })

            // Auto-logout after a brief delay so the user can read
            // the confirmation message.
            setTimeout(() => {
                State.logout(state).catch(() => {})
            }, AUTO_LOGOUT_DELAY_MS)
        } catch (err) {
            setStatus({
                kind: 'error',
                message: err instanceof Error ?
                    err.message :
                    'Something went wrong'
            })
        }
    }

    function handleCancel (e:Event) {
        e.preventDefault()
        state._setRoute('/settings')
    }

    if (status.kind === 'scheduled') {
        const isImmediate =
            status.scheduledFor <= Date.now() + 5 * 60 * 1000

        return html`<div class="route confirm-close success">
            <header class="confirm-close-header">
                <h1>${isImmediate ?
                    'Account deletion in progress' :
                    'Account deletion scheduled'}</h1>
            </header>
            <section class="confirm-close-body">
                ${isImmediate ? html`
                    <p>
                        Your account is being deleted now. You will be
                        signed out shortly.
                    </p>
                ` : html`
                    <p>
                        Your account will be deleted at the end of your
                        current billing cycle:
                    </p>
                    <p class="scheduled-date">
                        <strong>${formatDate(status.scheduledFor)}</strong>
                    </p>
                    <p>
                        You can cancel this deletion any time before then
                        from the Settings page. Signing you out now...
                    </p>
                `}
            </section>
        </div>`
    }

    return html`<div class="route confirm-close">
        <header class="confirm-close-header">
            <a
                href="/settings"
                class="back-link"
                onClick=${handleCancel}
            >
                ${'<'} Back to Settings
            </a>
            <h1>Delete your account</h1>
        </header>

        <section class="confirm-close-body danger">
            <p class="lede">
                This will permanently delete your RSSS account and
                all associated data, including feeds, read state,
                and starred items.
            </p>

            ${isEntitled ? html`
                <p>
                    Because you have an active subscription, deletion
                    will run at the end of your current billing cycle.
                    Until then you can cancel the deletion from
                    Settings.
                </p>
            ` : html`
                <p>
                    You are on the free plan, so deletion will happen
                    immediately and cannot be undone.
                </p>
            `}

            <p>
                Your Bluesky account is not affected. RSSS
                only deletes the data we store about your feeds and
                reading history.
            </p>

            ${status.kind === 'error' && html`
                <p class="error">${status.message}</p>
            `}

            <div class="actions">
                <button
                    type="button"
                    class="btn-confirm-delete"
                    disabled=${status.kind === 'submitting' || undefined}
                    onClick=${handleConfirm}
                >
                    ${status.kind === 'submitting' ?
                        'Deleting...' :
                        'Confirm Delete'}
                </button>
                <button
                    type="button"
                    class="btn-cancel"
                    onClick=${handleCancel}
                >
                    Cancel
                </button>
            </div>
        </section>
    </div>`
}
