import { type FunctionComponent } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import { html } from 'htm/preact'
import { Button } from './button.js'
import { type AppState, State } from '../state'
import { hasLocalStorage, syncFromRemote, getSyncState } from '../db/index.js'
import './sidebar-footer.css'

export const SidebarFooter: FunctionComponent<{
    state: AppState
}> = function (props) {
    const { state } = props
    const { feedsLoading } = state

    const [canSync, setCanSync] = useState(false)
    const [syncing, setSyncing] = useState(false)
    const [syncError, setSyncError] = useState<string | null>(null)
    const [lastSynced, setLastSynced] = useState<string | null>(null)

    // Check if IndexedDB is available for sync
    useEffect(() => {
        const available = hasLocalStorage()
        setCanSync(available)

        // Load sync state if available
        if (available) {
            getSyncState().then(syncState => {
                setLastSynced(syncState.lastSyncedAt)
            })
        }
    }, [])

    async function handleSync () {
        setSyncing(true)
        setSyncError(null)

        try {
            const result = await syncFromRemote()
            setLastSynced(result.latestUpdatedAt)

            // Reload data after sync
            await State.loadFeeds(state)
            await State.loadItems(state)
            await State.loadCounts(state)
        } catch (err) {
            setSyncError(err instanceof Error ? err.message : 'Sync failed')
        } finally {
            setSyncing(false)
        }
    }

    function formatLastSynced (dateStr: string | null): string {
        if (!dateStr) return 'Never'
        const date = new Date(dateStr)
        return date.toLocaleString()
    }

    return html`<div class="sidebar-footer">
        ${canSync && html`
            <div class="sync-section">
                <${Button}
                    onClick=${handleSync}
                    isSpinning=${syncing}
                    disabled=${syncing}
                >
                    ${syncing ? 'Syncing...' : 'Pull from Server'}
                <//>
                ${syncError && html`
                    <div class="sync-error">${syncError}</div>
                `}
                <div class="sync-status">
                    Last synced: ${formatLastSynced(lastSynced)}
                </div>
            </div>
        `}

        ${!canSync && html`
            <${Button}
                onClick=${() => State.refreshFeeds(state)}
                isSpinning=${feedsLoading}
            >
                Refresh Feeds
            <//>
        `}
        <div class="footer-links">
            <a href="/settings" class="settings-link">Settings</a>
        </div>
    </div>`
}
