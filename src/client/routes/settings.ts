import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useEffect } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { type AppState, State } from '../state.js'
import { billingStatus } from '../billing-status.js'
import {
    syncSubscriptions,
    storeContent,
    setSyncSubscriptions,
    saveLocalFirstSettings,
    loadLocalFirstSettings
} from '../local-first-settings.js'
import {
    isLocalFirstSupported,
    bootstrapLocalDb,
    bootstrapInProgress,
    bootstrapFeedsCount,
    bootstrapItemsCount,
    bootstrapError,
    disableLocalFirst,
    resetLocalFirst,
    getBootstrappedDb,
    getLocalDb,
    getOutboxCount,
    localTabLockError,
    LocalFirstSyncFailureError
} from '../db/index.js'
import '@substrate-system/check-box'
import './settings.css'

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { feeds } = state

    useEffect(() => {
        loadLocalFirstSettings()
        if (state.isAuthenticated.value) {
            State.loadBillingStatus(state)
        }
    }, [])

    const supported = isLocalFirstSupported()
    const inProgress = bootstrapInProgress.value
    const bError = bootstrapError.value
    const tabLockError = localTabLockError.value
    const billing = useComputed(() => billingStatus.value)
    const isEntitled = Boolean(billing.value?.entitled)
    const planLabel = billing.value?.planId ?? 'sync'

    function handleManageSubscription (e:Event) {
        e.preventDefault()
        State.openCustomerPortal(state)
    }

    function handleUpgrade (e:Event) {
        e.preventDefault()
        state._setRoute('/signup')
    }

    async function handleSyncChange (ev:Event) {
        const checked = (ev.target as HTMLInputElement).checked
        const did = state.user.value?.did
        if (checked) {
            setSyncSubscriptions(true)
            saveLocalFirstSettings()
            if (did) {
                bootstrapLocalDb(did)
            }
        } else {
            if (!did) {
                setSyncSubscriptions(false)
                saveLocalFirstSettings()
                return
            }
            const db = getBootstrappedDb() ?? getLocalDb(did)
            const pending = db ? getOutboxCount(db) : 0
            const lines = [
                'This will delete your local data on this device:',
                '  - Subscriptions cache',
                '  - Items cache'
            ]
            if (pending > 0) {
                lines.push(
                    `  - ${pending} pending offline change` +
                    (pending === 1 ? '' : 's') +
                    ' (will sync before deletion)'
                )
                lines.push(
                    'If sync fails, local storage will stay enabled.'
                )
            }
            lines.push('\nContinue?')
            const confirmed = confirm(lines.join('\n'))
            if (!confirmed) {
                // revert toggle
                setSyncSubscriptions(true)
                saveLocalFirstSettings()
                ;(ev.target as HTMLInputElement).checked = true
                return
            }
            if (!navigator.onLine && pending > 0) {
                alert(
                    'You are offline. Pending changes cannot be ' +
                    'synced and will be discarded. Proceeding anyway.'
                )
            }
            try {
                await disableLocalFirst(did)
            } catch (err) {
                const msg = err instanceof Error ?
                    err.message :
                    'Unable to disable local storage'
                alert(msg)
                setSyncSubscriptions(true)
                saveLocalFirstSettings()
                ;(ev.target as HTMLInputElement).checked = true
            }
        }
    }

    async function handleReset () {
        const did = state.user.value?.did
        if (!did) return
        const db = getBootstrappedDb() ?? getLocalDb(did)
        const pending = db ? getOutboxCount(db) : 0
        const lines = [
            'This will wipe and re-download all local data.'
        ]
        if (pending > 0) {
            lines.push(
                `${pending} pending offline change` +
                (pending === 1 ? '' : 's') +
                ' will be synced before wiping.'
            )
            lines.push(
                'If sync fails, reset will be cancelled unless you ' +
                'confirm discarding pending changes.'
            )
        }
        lines.push('Continue?')
        if (!confirm(lines.join('\n'))) return
        try {
            await resetLocalFirst(did)
        } catch (err) {
            if (!(err instanceof LocalFirstSyncFailureError)) {
                alert(err instanceof Error ? err.message : 'Reset failed')
                return
            }

            const confirmed = confirm([
                err.message,
                '',
                'Reset anyway and discard pending local changes?'
            ].join('\n'))
            if (!confirmed) return

            try {
                await resetLocalFirst(did, fetch, {
                    allowDataLossOnSyncFailure: true
                })
            } catch (resetErr) {
                alert(resetErr instanceof Error ?
                    resetErr.message :
                    'Reset failed')
            }
        }
    }

    function handleContentChange (ev:Event) {
        const checked = (ev.target as HTMLInputElement).checked
        storeContent.value = checked
        saveLocalFirstSettings()
    }

    return html`<div class="route settings">
        <header class="settings-header">
            <a href="/" class="back-link">${'<'} Back to Feeds</a>
            <h1>Settings</h1>
        </header>

        <section class="settings-section subscription-section">
            <h2>Subscription</h2>
            ${isEntitled ? html`
                <p>
                    You're on the
                    <strong>${planLabel}</strong> plan. Your feeds
                    sync across all your devices.
                </p>
                <button
                    class="btn-manage"
                    onClick=${handleManageSubscription}
                >
                    Manage subscription
                </button>
            ` : html`
                <p>
                    You're on the <strong>Free</strong> plan. Your
                    feeds and read state stay on this device only.
                </p>
                <button
                    class="btn-upgrade"
                    onClick=${handleUpgrade}
                >
                    Upgrade to Sync
                </button>
            `}
        </section>

        <section class="settings-section local-first-section">
            <h2>Local Storage</h2>
            ${!supported && html`
                <p class="unsupported-note">
                    Local storage is not supported in this browser.
                </p>
            `}
            ${tabLockError && html`
                <p class="unsupported-note">
                    ${tabLockError}
                </p>
            `}
            <div class="local-first-toggle">
                <check-box
                    name="sync-subscriptions"
                    checked=${syncSubscriptions.value || undefined}
                    disabled=${(!supported || inProgress) || undefined}
                    onChange=${handleSyncChange}
                >
                    Sync subscriptions and read state to this device
                </check-box>
            </div>
            <div class="local-first-toggle">
                <check-box
                    name="store-content"
                    checked=${storeContent.value || undefined}
                    disabled=${(!supported || !syncSubscriptions.value ||
                        inProgress) || undefined}
                    onChange=${handleContentChange}
                >
                    Store article content locally for offline reading
                </check-box>
            </div>
            ${inProgress && html`
                <div class="bootstrap-progress">
                    <p class="bootstrap-status">
                        Setting up local storage...
                    </p>
                    <p class="bootstrap-counts">
                        ${bootstrapFeedsCount.value} feeds,
                        ${bootstrapItemsCount.value} items synced
                    </p>
                </div>
            `}
            ${bError && html`
                <p class="bootstrap-error">
                    Setup failed: ${bError}
                </p>
            `}
            ${syncSubscriptions.value && !inProgress && html`
                <div class="reset-local-data">
                    <button
                        class="btn-reset"
                        onClick=${handleReset}
                    >
                        Reset local data
                    </button>
                    <p class="reset-desc">
                        Sync pending changes, then wipe local data and
                        re-download from server.
                    </p>
                </div>
            `}
        </section>

        <section class="settings-section">
            <h2>Subscribed Feeds</h2>
            <ul class="settings-feeds-list">
                ${feeds.value.length === 0 ?
            html`
                        <p class="empty-state">
                            No feeds followed yet.
                        </p>
                    ` : feeds.value.map(feed => {
                return html`
                        <li
                            class="settings-feed-item"
                            key=${feed.url}
                        >
                            <div class="feed-info">
                                <span class="feed-title">
                                    ${feed.title || feed.url}
                                </span>
                                <a
                                    href="${feed.url}"
                                    class="feed-url"
                                >
                                    ${feed.url}
                                </a>
                            </div>
                            <button
                                class="btn-delete"
                                onClick=${(e:Event) => {
                                    e.preventDefault()
                                    if (confirm(
                                        'Are you sure you want' +
                                        ' to unfollow this feed?'
                                    )) {
                                        State.deleteFeed(
                                            state,
                                            feed.id
                                        )
                                    }
                                }}
                            >
                                Unfollow
                            </button>
                        </li>
                        `
            })
        }
            </ul>
        </section>
    </div>`
}
