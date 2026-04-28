/**
 * Global signals for the user's current billing/entitlement state.
 * Mirrors the shape of the server's GET /api/billing/status response.
 */
import { type Signal, signal, batch } from '@preact/signals'

export interface PendingDeletion {
    scheduledFor:number
}

export interface BillingStatus {
    entitled:boolean
    planId:string
    status:'active'|'scheduled'|'none'
    refreshedAt:number
    useLive:boolean
    pendingDeletion?:PendingDeletion|null
}

export const billingStatus:Signal<BillingStatus|null> =
    signal(null)
export const billingError:Signal<string|null> = signal(null)
export const checkoutInProgress:Signal<boolean> = signal(false)

export function setBillingStatus (s:BillingStatus|null):void {
    billingStatus.value = s
}

export function setBillingError (msg:string|null):void {
    billingError.value = msg
}

export function setCheckoutInProgress (v:boolean):void {
    checkoutInProgress.value = v
}

export function resetBilling ():void {
    batch(() => {
        billingStatus.value = null
        billingError.value = null
        checkoutInProgress.value = false
    })
}
