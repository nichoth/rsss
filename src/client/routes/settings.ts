import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { useComputed, batch } from '@preact/signals'
import { CheckBox } from '@substrate-system/check-box'
import { type AppState, State } from '../state.js'
import { billingStatus } from '../billing-status.js'
import { RadioInput } from '@substrate-system/radio-input'
import {
    syncSubscriptions,
    pendingSyncSubscriptions,
    storeContent,
    defaultCacheMode,
    defaultMaxSizeBytes,
    defaultMaxAgeSeconds,
    defaultAccountMaxSizeBytes,
    setSyncSubscriptions,
    saveLocalFirstSettings,
    loadLocalFirstSettings,
    type CacheMode
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
    purgeStoredContent,
    clearFeedCache
} from '../db/index.js'
import {
    feedPolicies,
    loadFeedPolicies,
    upsertFeedCachePolicy,
    resolveEffectivePolicy,
    type FeedCachePolicyRow
} from '../db/feed-cache-policy.js'
import {
    feedStorageBytes,
    totalStorageBytes,
    loadStorageUsage
} from '../db/storage-usage.js'
import { NBSP } from '../constants.js'
import { formatBytes } from '../util.js'
import './settings.css'
import '@substrate-system/radio-input/css'

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

    useEffect(() => {
        const did = state.user.value?.did
        const db = did ?
            (getBootstrappedDb() ?? getLocalDb(did)) :
            null
        if (!db || feeds.value.length === 0) return
        const ids = feeds.value.map(f => f.id)
        loadFeedPolicies(db, ids).catch(() => {})
    }, [feeds.value, syncSubscriptions.value])

    useEffect(() => {
        const did = state.user.value?.did
        const db = did ?
            (getBootstrappedDb() ?? getLocalDb(did)) :
            null
        if (!db || feeds.value.length === 0) return
        const ids = feeds.value.map(f => f.id)
        loadStorageUsage(db, ids).catch(() => {})
    }, [feeds.value, syncSubscriptions.value])

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

    function handleCacheModeChange (ev:Event) {
        const val = (ev.target as HTMLInputElement).value
        if (val === 'text' || val === 'text_images') {
            batch(() => {
                defaultCacheMode.value = val
            })
            saveLocalFirstSettings()
        }
    }

    function handleMaxSizeChange (ev:Event) {
        const mb = parseFloat((ev.target as HTMLInputElement).value)
        if (isFinite(mb) && mb >= 1) {
            batch(() => {
                defaultMaxSizeBytes.value = Math.round(mb * 1_000_000)
            })
            saveLocalFirstSettings()
        }
    }

    function handleMaxAgeChange (ev:Event) {
        const days = parseFloat((ev.target as HTMLInputElement).value)
        if (isFinite(days) && days >= 1) {
            batch(() => {
                defaultMaxAgeSeconds.value = Math.round(days * 86400)
            })
            saveLocalFirstSettings()
        }
    }

    function handleAccountMaxSizeChange (ev:Event) {
        const mb = parseFloat((ev.target as HTMLInputElement).value)
        if (isFinite(mb) && mb >= 1) {
            batch(() => {
                defaultAccountMaxSizeBytes.value =
                    Math.round(mb * 1_000_000)
            })
            saveLocalFirstSettings()
        }
    }

    function getLocalDbForUser ():ReturnType<typeof getBootstrappedDb> {
        const did = state.user.value?.did
        return did ?
            (getBootstrappedDb() ?? getLocalDb(did)) :
            null
    }

    async function saveFeedPolicy (
        feedId:number,
        patch:Partial<FeedCachePolicyRow>
    ):Promise<void> {
        const current = feedPolicies.value[feedId] ?? null
        const updated:FeedCachePolicyRow = {
            feed_id: feedId,
            cache_mode: current?.cache_mode ?? null,
            max_size_bytes: current?.max_size_bytes ?? null,
            max_age_seconds: current?.max_age_seconds ?? null,
            ...patch
        }
        feedPolicies.value = {
            ...feedPolicies.value,
            [feedId]: updated
        }
        const db = getLocalDbForUser()
        if (!db) return
        try {
            await upsertFeedCachePolicy(db, feedId, updated)
        } catch (err) {
            console.error(
                '[settings] feed policy save failed',
                err instanceof Error ? err.message : ''
            )
        }
    }

    function handleFeedCacheModeChange (feedId:number) {
        return (ev:Event) => {
            const val = (ev.target as HTMLSelectElement).value
            const mode = (val === 'text' || val === 'text_images') ?
                val as CacheMode :
                null
            saveFeedPolicy(feedId, { cache_mode: mode })
        }
    }

    function handleFeedMaxSizeChange (feedId:number) {
        return (ev:Event) => {
            const raw = (ev.target as HTMLInputElement).value.trim()
            const mb = raw === '' ? null : parseFloat(raw)
            const bytes = (mb !== null && isFinite(mb) && mb >= 1) ?
                Math.round(mb * 1_000_000) :
                null
            saveFeedPolicy(feedId, { max_size_bytes: bytes })
        }
    }

    function handleFeedMaxAgeChange (feedId:number) {
        return (ev:Event) => {
            const raw = (ev.target as HTMLInputElement).value.trim()
            const days = raw === '' ? null : parseFloat(raw)
            const secs = (days !== null && isFinite(days) && days >= 1) ?
                Math.round(days * 86400) :
                null
            saveFeedPolicy(feedId, { max_age_seconds: secs })
        }
    }

    function handleClearFeedCache (feedId:number, feedTitle:string) {
        return async (e:Event) => {
            e.preventDefault()
            if (!confirm(
                `Clear cached content for "${feedTitle}"? ` +
                'This will free space but article content will need ' +
                'to be re-fetched.'
            )) return
            const db = getLocalDbForUser()
            if (!db) return
            try {
                await clearFeedCache(db, feedId)
                const ids = feeds.value.map(f => f.id)
                await loadStorageUsage(db, ids)
            } catch (err) {
                console.error(
                    '[settings] clear feed cache failed',
                    err instanceof Error ? err.message : ''
                )
            }
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
                    You're on the <strong>${planLabel}</strong> plan.
                    Your feeds can be stored on each device for offline reading.
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
        </section>

        <section class="settings-section cache-section">
            <h2>Cache</h2>
            <p class="cache-total">
                Total storage used: ${formatBytes(totalStorageBytes.value)}
            </p>
            <p class="section-desc">
                These are the defaults. They can be overridden per-feed.
            </p>
            <div class="cache-setting">
                <fieldset class="cache-mode-group">
                    <legend>Cache mode</legend>
                    <${RadioInput.TAG}
                        name="default-cache-mode"
                        value="text"
                        checked=${defaultCacheMode.value === 'text'}
                        onChange=${handleCacheModeChange}
                        label="Text Only"
                    ><//>
                    <${RadioInput.TAG}
                        name="default-cache-mode"
                        value="text_images"
                        checked=${defaultCacheMode.value === 'text_images'}
                        label="Text and Images"
                        onChange=${handleCacheModeChange}
                    ><//>
                </fieldset>
            </div>
            <div class="cache-setting">
                <label class="cache-input-label">
                    Max cache size per feed (MB)
                    <input
                        type="number"
                        name="default-max-size-mb"
                        min="1"
                        value=${Math.round(
                            defaultMaxSizeBytes.value / 1_000_000
                        )}
                        onChange=${handleMaxSizeChange}
                    />
                </label>
            </div>
            <div class="cache-setting">
                <label class="cache-input-label">
                    Total cache size (MB)
                    <input
                        type="number"
                        name="account-max-size-mb"
                        min="1"
                        value=${Math.round(
                            defaultAccountMaxSizeBytes.value / 1_000_000
                        )}
                        onChange=${handleAccountMaxSizeChange}
                    />
                </label>
            </div>
            <div class="cache-setting">
                <label class="cache-input-label">
                    Keep cached items for (days)
                    <input
                        type="number"
                        name="default-max-age-days"
                        min="1"
                        value=${Math.round(
                            defaultMaxAgeSeconds.value / 86400
                        )}
                        onChange=${handleMaxAgeChange}
                    />
                </label>
            </div>
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
                const policy = feedPolicies.value[feed.id] ?? null
                const eff = resolveEffectivePolicy(policy)
                const modeLabel = eff.cacheMode === 'text' ?
                    'Text only' :
                    'Text + images'
                const sizeVal = policy?.max_size_bytes != null ?
                    String(Math.round(
                        policy.max_size_bytes / 1_000_000
                    )) :
                    ''
                const ageVal = policy?.max_age_seconds != null ?
                    String(Math.round(
                        policy.max_age_seconds / 86400
                    )) :
                    ''
                const storedBytes = feedStorageBytes.value[feed.id] ?? 0
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
                                <span class="feed-cache-mode">
                                    ${modeLabel}${eff.isDefault.cacheMode ?
                                        ' (default)' :
                                        ''}
                                </span>
                                <span class="feed-storage">
                                    ${formatBytes(storedBytes)} cached
                                </span>
                            </div>
                            <div class="feed-controls">
                                <details class="feed-cache-controls">
                                    <summary>Cache settings</summary>
                                    <div class="feed-cache-form">
                                        <label class="cache-field-label">
                                            Cache mode
                                            <select
                                                name=${`feed-cache-mode-${feed.id}`}
                                                onChange=${handleFeedCacheModeChange(
                                                    feed.id
                                                )}
                                            >
                                                <option
                                                    value=""
                                                    selected=${
                                                        policy?.cache_mode ==
                                                        null
                                                    }
                                                >
                                                    Use default
                                                </option>
                                                <option
                                                    value="text"
                                                    selected=${
                                                        policy?.cache_mode ===
                                                        'text'
                                                    }
                                                >
                                                    Text only
                                                </option>
                                                <option
                                                    value="text_images"
                                                    selected=${
                                                        policy?.cache_mode ===
                                                        'text_images'
                                                    }
                                                >
                                                    Text + images
                                                </option>
                                            </select>
                                        </label>
                                        <label class="cache-field-label">
                                            Max size (MB, blank = default)
                                            <input
                                                type="number"
                                                name=${`feed-max-size-${feed.id}`}
                                                min="1"
                                                value=${sizeVal}
                                                placeholder="default"
                                                onChange=${handleFeedMaxSizeChange(
                                                    feed.id
                                                )}
                                            />
                                        </label>
                                        <label class="cache-field-label">
                                            Keep for (days, blank = default)
                                            <input
                                                type="number"
                                                name=${`feed-max-age-${feed.id}`}
                                                min="1"
                                                value=${ageVal}
                                                placeholder="default"
                                                onChange=${handleFeedMaxAgeChange(
                                                    feed.id
                                                )}
                                            />
                                        </label>
                                    </div>
                                    <button
                                        class="btn-clear-cache"
                                        onClick=${handleClearFeedCache(
                                            feed.id,
                                            feed.title || feed.url
                                        )}
                                    >
                                        Clear cache
                                    </button>
                                </details>
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
                            </div>
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
