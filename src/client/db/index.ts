/**
 * Database adapter factory
 *
 * Returns the appropriate adapter based on the runtime environment:
 * - Tauri (desktop): local SQLite adapter with sync capability
 * - Browser (web): remote API adapter
 */

import type { DbAdapter, SyncResponse, SyncState } from './types.js'

export type * from './types.js'

/**
 * Check if we're running in Tauri
 */
export function isTauri (): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window
}

/**
 * Get the database adapter for the current environment
 */
export async function getAdapter (): Promise<DbAdapter> {
    if (isTauri()) {
        const { localAdapter } = await import('./local-adapter.js')
        return localAdapter
    } else {
        const { remoteAdapter } = await import('./remote-adapter.js')
        return remoteAdapter
    }
}

/**
 * Sync from remote server (only available in Tauri)
 */
export async function syncFromRemote (remoteUrl: string): Promise<SyncResponse> {
    if (!isTauri()) {
        throw new Error('Sync is only available in desktop app')
    }

    const { localAdapter } = await import('./local-adapter.js')
    return localAdapter.sync(remoteUrl)
}

/**
 * Get sync state (only available in Tauri)
 */
export async function getSyncState (): Promise<SyncState> {
    if (!isTauri()) {
        return { lastSyncedAt: null, remoteUrl: null }
    }

    const { localAdapter } = await import('./local-adapter.js')
    return localAdapter.getSyncState()
}
