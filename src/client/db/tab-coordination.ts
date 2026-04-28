import { type Signal, signal } from '@preact/signals'

const CHANNEL_NAME = 'rsss-tab'
const LOCK_NAME = 'rsss-opfs'
export const LOCAL_TAB_LOCK_ERROR = 'Local data is open in another tab'

type TabMessage = {
    type:'hello'|'primary'|'released'
}

type TabState = 'idle'|'waiting'|'primary'|'blocked'

export type TabCoordinator = {
    close:() => void
}

export const localTabLockError:Signal<string|null> = signal(null)
export const localTabLockRevision:Signal<number> = signal(0)

let channel:BroadcastChannel|null = null
let tabState:TabState = 'idle'
let releaseRegistered = false
let releaseLock:(() => void)|null = null
let releaseDone:Promise<void>|null = null
let activeLockRequest:Promise<unknown>|null = null
let waitingLockPromise:Promise<boolean>|null = null

function setTabState (next:TabState):void {
    if (tabState === next) return
    tabState = next
    localTabLockRevision.value++
}

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
        setTabState('blocked')
        localTabLockError.value = LOCAL_TAB_LOCK_ERROR
        return
    }

    if (event.data.type === 'released' && tabState === 'blocked') {
        setTabState('waiting')
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
    setTabState('waiting')
    post({ type: 'hello' })
    registerReleaseOnUnload()

    return {
        close: () => {
            channel?.close()
            channel = null
            setTabState('idle')
            localTabLockError.value = null
        }
    }
}

function lockManager ():LockManager|undefined {
    return navigator.locks
}

function holdLockUntilReleased ():Promise<void> {
    releaseDone = new Promise(resolve => {
        releaseLock = () => {
            releaseLock = null
            resolve()
        }
    })
    return releaseDone
}

function startWaitingForLock (locks:LockManager):Promise<boolean> {
    if (waitingLockPromise) return waitingLockPromise

    waitingLockPromise = new Promise((resolve, reject) => {
        activeLockRequest = locks.request(
            LOCK_NAME,
            { mode: 'exclusive' },
            async () => {
                waitingLockPromise = null
                markLocalTabPrimary()
                resolve(true)
                await holdLockUntilReleased()
            }
        )

        activeLockRequest.catch((err) => {
            waitingLockPromise = null
            activeLockRequest = null
            reject(err)
        })
    })

    return waitingLockPromise
}

export async function acquireLocalTabLock ():Promise<boolean> {
    startTabCoordination()
    if (tabState === 'primary') return true
    if (waitingLockPromise) return waitingLockPromise

    const locks = lockManager()
    if (!locks) {
        if (tabState === 'blocked') return false
        markLocalTabPrimary()
        return true
    }

    const acquired = await new Promise<boolean>((resolve, reject) => {
        activeLockRequest = locks.request(
            LOCK_NAME,
            { ifAvailable: true, mode: 'exclusive' },
            async (lock) => {
                if (!lock) {
                    resolve(false)
                    return
                }

                markLocalTabPrimary()
                resolve(true)
                await holdLockUntilReleased()
            }
        )
        activeLockRequest.catch((err) => {
            activeLockRequest = null
            reject(err)
        })
    })

    if (!acquired) {
        setLocalTabBlocked()
        startWaitingForLock(locks).catch(() => {})
    }

    return acquired
}

export async function releaseLocalTabLock ():Promise<void> {
    const request = activeLockRequest
    releaseLock?.()
    await releaseDone
    await request
    releaseDone = null
    activeLockRequest = null
    markLocalTabReleased()
}

export function markLocalTabPrimary ():void {
    startTabCoordination()
    setTabState('primary')
    localTabLockError.value = null
    post({ type: 'primary' })
}

export function markLocalTabReleased ():void {
    if (tabState === 'primary') {
        post({ type: 'released' })
    }
    setTabState('waiting')
    localTabLockError.value = null
}

export function isLocalTabBlocked ():boolean {
    startTabCoordination()
    return tabState === 'blocked'
}

export function setLocalTabBlocked ():void {
    startTabCoordination()
    setTabState('blocked')
    localTabLockError.value = LOCAL_TAB_LOCK_ERROR
}

export function getTabCoordinationState ():TabState {
    return tabState
}

export function getLocalTabLockError ():Signal<string|null> {
    return localTabLockError
}

export function resetTabCoordinationForTests ():void {
    releaseLock?.()
    releaseLock = null
    releaseDone = null
    activeLockRequest = null
    waitingLockPromise = null
    channel?.close()
    channel = null
    tabState = 'idle'
    releaseRegistered = false
    localTabLockError.value = null
    localTabLockRevision.value = 0
}
