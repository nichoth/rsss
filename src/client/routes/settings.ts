import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { useComputed } from '@preact/signals'
import { CheckBox } from '@substrate-system/check-box'
import { type AppState, State } from '../state.js'
import { billingStatus } from '../billing-status.js'
import {
    syncSubscriptions,
    pendingSyncSubscriptions,
    storeContent,
    setSyncSubscriptions,
    saveLocalFirstSettings,
    loadLocalFirstSettings
} from '../local-first-settings.js'
import {
    isLocalFirstSupported,
    localFirstSupported,
    bootstrapLocalDb,
    bootstrapInProgress,
    bootstrapFeedsCount,
    bootstrapItemsCount,
    bootstrapError,
    bootstrapRetryAvailable,
    bootstrapStorageWarning,
    disableLocalFirst,
    getBootstrappedDb,
    getLocalDb,
    getOutboxCount,
    localTabLockError,
    localDbError,
    purgeStoredContent
} from '../db/index.js'
import { runSyncCycle } from '../db/sync-cycle.js'
import { syncStatus, syncError } from '../db/sync-status.js'
import './settings.css'
import { NBSP } from '../constants.js'

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props
    const { feeds } = state
    const pendingBootstrapDid = useRef<string|null>(null)

    useEffect(() => {
        loadLocalFirstSettings()
        isLocalFirstSupported()
        if (state.isAuthenticated.value) {
            State.loadBillingStatus()
        }
    }, [])

    const supported = localFirstSupported.value
    const inProgress = bootstrapInProgress.value
    const bError = bootstrapError.value
    const dbError = localDbError.value
    const tabLockError = localTabLockError.value
    const billing = useComputed(() => billingStatus.value)
    const isEntitled = Boolean(billing.value?.entitled)
    const isBillingLoaded = billing.value !== null
    const syncChecked = syncSubscriptions.value ||
        pendingSyncSubscriptions.value
    const planLabel = billing.value?.planId ?? 'local-first'
    const pendingDeletion = useComputed(() =>
        billing.value?.pendingDeletion ?? null)

    async function handleCancelDeletion () {
        try {
            await State.cancelAccountDeletion()
        } catch (err) {
            alert(err instanceof Error ?
                err.message :
                'Failed to cancel deletion')
        }
    }

    function handleDeleteAccount (e:Event) {
        e.preventDefault()
        state._setRoute('/confirm-close')
    }

    function formatDeletionDate (ms:number):string {
        return new Date(ms).toLocaleString()
    }

    useEffect(() => {
        const did = pendingBootstrapDid.current
        if (!did) return
        if (pendingSyncSubscriptions.value || !syncSubscriptions.value) return

        pendingBootstrapDid.current = null
        bootstrapLocalDb(did, fetch, {
            confirmTerminalReset: confirmTerminalBootstrapReset,
            confirmLowStorage: confirmLowStorageBootstrap
        })
    }, [pendingSyncSubscriptions.value, syncSubscriptions.value])

    function handleManageSubscription (e:Event) {
        e.preventDefault()
        State.openCustomerPortal()
    }

    function handleUpgrade (e:Event) {
        e.preventDefault()
        state._setRoute('/signup')
    }

    function confirmTerminalBootstrapReset (message:string):boolean {
        return confirm([
            `Setup failed: ${message}`,
            '',
            'Reset local storage on this device and turn off ' +
            'local storage?'
        ].join('\n'))
    }

    function confirmLowStorageBootstrap (message:string):boolean {
        return confirm([
            message,
            '',
            'Continue setting up local storage anyway?'
        ].join('\n'))
    }

    async function handleSyncChange (ev:Event) {
        const checked = (ev.target as HTMLInputElement).checked
        const did = state.user.value?.did
        if (checked) {
            const result = setSyncSubscriptions(true)
            saveLocalFirstSettings()
            if (result === 'applied' && did) {
                bootstrapLocalDb(did, fetch, {
                    confirmTerminalReset: confirmTerminalBootstrapReset,
                    confirmLowStorage: confirmLowStorageBootstrap
                })
            } else if (result === 'pending' && did) {
                pendingBootstrapDid.current = did
            }
        } else if (!syncSubscriptions.value) {
            setSyncSubscriptions(false)
            saveLocalFirstSettings()
        } else {
            if (!did) {
                setSyncSubscriptions(false)
                saveLocalFirstSettings()
                return
            }
            const db = getBootstrappedDb() ?? getLocalDb(did)
            const pending = db ? await getOutboxCount(db) : 0
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

    function handleBootstrapRetry () {
        const did = state.user.value?.did
        if (!did) return
        bootstrapLocalDb(did, fetch, {
            confirmTerminalReset: confirmTerminalBootstrapReset,
            confirmLowStorage: confirmLowStorageBootstrap
        })
    }

    async function handleSync () {
        const did = state.user.value?.did
        if (!did) return
        const db = getBootstrappedDb() ?? getLocalDb(did)
        if (!db) return
        try {
            await runSyncCycle(db)
        } catch {
            // runSyncCycle surfaces failures via the syncError signal.
        }
    }

    async function handleContentChange (ev:Event) {
        const target = ev.target as HTMLInputElement
        const checked = target.checked
        if (checked) {
            storeContent.value = true
            saveLocalFirstSettings()
            return
        }

        const did = state.user.value?.did
        const db = did ? getBootstrappedDb() ?? getLocalDb(did) : null

        try {
            if (db) await purgeStoredContent(db)
            storeContent.value = false
            saveLocalFirstSettings()
        } catch (err) {
            alert(err instanceof Error ?
                err.message :
                'Unable to clear local article content')
            storeContent.value = true
            saveLocalFirstSettings()
            target.checked = true
        }
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
                    <strong>${planLabel}</strong> plan. Your feeds and
                    read state are stored on each device and sync
                    automatically.
                </p>
                <button
                    class="btn-manage"
                    onClick=${handleManageSubscription}
                >
                    Manage subscription
                </button>
            ` : html`
                <p>
                    You're on the <strong>Free</strong> plan. RSSS
                    works while you're online only.
                </p>
                <button
                    class="btn-upgrade"
                    onClick=${handleUpgrade}
                >
                    Upgrade to Local-first
                </button>
            `}
        </section>

        <section class="settings-section local-first-section">
            <h2>Local Storage</h2>
            ${!isEntitled && html`
                <p class="upgrade-note">
                    Local storage is part of the Local-first plan.${NBSP}
                    <a href="/signup" onClick=${handleUpgrade}>Upgrade</a>
                    ${NBSP}to keep your feeds on this device and work offline.
                </p>
            `}
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
                <${CheckBox.TAG}
                    name="sync-subscriptions"
                    aria-describedby="sync-subscriptions-desc"
                    checked=${syncChecked || undefined}
                    disabled=${((isBillingLoaded && !isEntitled) ||
                        !supported || inProgress) || undefined}
                    onChange=${handleSyncChange}
                >
                    Sync subscriptions and read state to this device
                <//>
                <p class="toggle-desc" id="sync-subscriptions-desc">
                    Keeps subscriptions, read state, and starred items in
                    local SQLite storage on this device.
                </p>
            </div>
            <div class="local-first-toggle">
                <check-box
                    name="store-content"
                    aria-describedby="store-content-desc"
                    checked=${storeContent.value || undefined}
                    disabled=${((isBillingLoaded && !isEntitled) ||
                        !supported ||
                        !syncSubscriptions.value || inProgress) ||
                        undefined}
                    onChange=${handleContentChange}
                >
                    Store article content locally for offline reading
                </check-box>
                <p
                    class="toggle-desc"
                    id="store-content-desc"
                >
                    Stores article bodies locally only when local storage is
                    enabled.
                </p>
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
            ${bootstrapStorageWarning.value && html`
                <p class="bootstrap-warning">
                    ${bootstrapStorageWarning.value}
                </p>
            `}
            ${bootstrapRetryAvailable.value && !inProgress && html`
                <button
                    class="btn-retry-bootstrap"
                    onClick=${handleBootstrapRetry}
                >
                    Retry setup
                </button>
            `}
            ${dbError && html`
                <p class="bootstrap-error">
                    ${dbError.message}
                </p>
            `}
            ${syncSubscriptions.value && !inProgress && !dbError && html`
                <div class="sync-local-data">
                    <button
                        class="btn-sync"
                        onClick=${handleSync}
                        disabled=${syncStatus.value === 'syncing' ||
                            undefined}
                    >
                        ${syncStatus.value === 'syncing' ?
                            'Syncing...' :
                            'Sync'}
                    </button>
                    <p class="sync-desc">
                        Pull updates from the server.
                    </p>
                </div>
                ${syncError.value && html`
                    <p class="bootstrap-error">${syncError.value}</p>
                `}
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

        <section class="settings-section danger-zone">
            <h2>Delete</h2>
            ${pendingDeletion.value ? html`
                <p class="pending-deletion-notice">
                    <strong>Account deletion scheduled.</strong>
                    ${' '}Your account will be deleted on
                    ${' '}${formatDeletionDate(
                        pendingDeletion.value.scheduledFor)}.
                </p>
                <button
                    class="btn"
                    onClick=${handleCancelDeletion}
                >
                    Cancel deletion
                </button>
            ` : html`
                <p>
                    Permanently delete your account and all associated
                    data. This action cannot be undone.
                </p>
                <a
                    href="/confirm-close"
                    class="btn"
                    onClick=${handleDeleteAccount}
                >
                    Delete account
                </a>
            `}
        </section>
    </div>`
}
