/**
 * Database adapter factory
 *
 * Returns the appropriate adapter based on the runtime environment:
 * - PWA with offline mode: local IndexedDB adapter with sync capability
 * - Online web app: remote API adapter
 */

import type { DbAdapter, SyncResponse, SyncState } from './types.js'

export type * from './types.js'

/**
 * Check if IndexedDB is available for local storage
 */
export function hasLocalStorage (): boolean {
    return typeof indexedDB !== 'undefined'
}

/**
 * Check if the app is running in standalone PWA mode (installed)
 */
export function isPWAInstalled (): boolean {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        // @ts-expect-error - iOS Safari specific
        window.navigator.standalone === true
    )
}

/**
 * Get the database adapter for the current environment
 * Uses remote API by default, but local adapter is available for offline sync
 */
export async function getAdapter (): Promise<DbAdapter> {
    // Always use remote adapter for online operations
    const { remoteAdapter } = await import('./remote-adapter.js')
    return remoteAdapter
}

/**
 * Get the local adapter for offline storage and sync
 */
export async function getLocalAdapter () {
    const { localAdapter } = await import('./local-adapter.js')
    return localAdapter
}

/**
 * Sync from remote server to local IndexedDB
 */
export async function syncFromRemote (remoteUrl: string): Promise<SyncResponse> {
    if (!hasLocalStorage()) {
        throw new Error('IndexedDB not available')
    }

    const { localAdapter } = await import('./local-adapter.js')
    return localAdapter.sync(remoteUrl)
}

/**
 * Get sync state from local storage
 */
export async function getSyncState (): Promise<SyncState> {
    if (!hasLocalStorage()) {
        return { lastSyncedAt: null, remoteUrl: null }
    }

    const { localAdapter } = await import('./local-adapter.js')
    return localAdapter.getSyncState()
}
