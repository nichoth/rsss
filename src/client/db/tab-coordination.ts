import { type Signal, signal } from '@preact/signals'

const CHANNEL_NAME = 'rsss-tab'
export const LOCAL_TAB_LOCK_ERROR = 'Local data is open in another tab'

type TabMessage = {
    type:'hello'|'primary'|'released'
}

type TabState = 'idle'|'waiting'|'primary'|'blocked'

export type TabCoordinator = {
    close:() => void
}

export const localTabLockError:Signal<string|null> = signal(null)

let channel:BroadcastChannel|null = null
let tabState:TabState = 'idle'
let releaseRegistered = false

function isTabMessage (data:unknown):data is TabMessage {
    if (data == null || typeof data !== 'object') return false
    const type = (data as { type?:unknown }).type
    return type === 'hello' || type === 'primary' || type === 'released'
}

function post (message:TabMessage):void {
    channel?.postMessage(message)
}

function handleMessage (event:MessageEvent):void {
    if (!isTabMessage(event.data)) return

    if (event.data.type === 'hello' && tabState === 'primary') {
        post({ type: 'primary' })
        return
    }

    if (event.data.type === 'primary' && tabState !== 'primary') {
        tabState = 'blocked'
        localTabLockError.value = LOCAL_TAB_LOCK_ERROR
        return
    }

    if (event.data.type === 'released' && tabState === 'blocked') {
        tabState = 'waiting'
        localTabLockError.value = null
    }
}

function registerReleaseOnUnload ():void {
    if (releaseRegistered || typeof window === 'undefined') return
    releaseRegistered = true
    window.addEventListener('pagehide', () => {
        if (tabState === 'primary') {
            post({ type: 'released' })
        }
    })
}

export function startTabCoordination ():TabCoordinator {
    if (typeof BroadcastChannel === 'undefined') {
        return { close: () => {} }
    }

    if (channel) {
        return { close: () => channel?.close() }
    }

    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = handleMessage
    tabState = 'waiting'
    post({ type: 'hello' })
    registerReleaseOnUnload()

    return {
        close: () => {
            channel?.close()
            channel = null
            tabState = 'idle'
            localTabLockError.value = null
        }
    }
}

export function markLocalTabPrimary ():void {
    startTabCoordination()
    tabState = 'primary'
    localTabLockError.value = null
    post({ type: 'primary' })
}

export function markLocalTabReleased ():void {
    if (tabState === 'primary') {
        post({ type: 'released' })
    }
    tabState = 'waiting'
    localTabLockError.value = null
}

export function isLocalTabBlocked ():boolean {
    startTabCoordination()
    return tabState === 'blocked'
}

export function setLocalTabBlocked ():void {
    startTabCoordination()
    tabState = 'blocked'
    localTabLockError.value = LOCAL_TAB_LOCK_ERROR
}

export function getTabCoordinationState ():TabState {
    return tabState
}

export function getLocalTabLockError ():Signal<string|null> {
    return localTabLockError
}

export function resetTabCoordinationForTests ():void {
    channel?.close()
    channel = null
    tabState = 'idle'
    releaseRegistered = false
    localTabLockError.value = null
}
