/**
 * Autumn billing helpers. The single Bluesky DID is used as the
 * Autumn customer id, so a user's checkout/subscription state is
 * keyed directly on their existing identity.
 *
 * When `useLive` is false (no `AUTUMN_SECRET_KEY` or `AUTUMN_DISABLED`
 * is set), all functions short-circuit so local dev does not require
 * a real Autumn account.
 */
import { Autumn } from 'autumn-js'

export interface BillingEnv {
    AUTUMN_SECRET_KEY?:string;
    AUTUMN_DISABLED?:string;
    NODE_ENV?:string;
}

export const BILLING_PLAN_IDS = ['sync'] as const
export type BillingPlanId = typeof BILLING_PLAN_IDS[number]

export function isValidPlanId (id:string):id is BillingPlanId {
    return (BILLING_PLAN_IDS as readonly string[]).includes(id)
}

export function useLive (env:BillingEnv):boolean {
    if (env.AUTUMN_DISABLED) return false
    return Boolean(env.AUTUMN_SECRET_KEY)
}

/**
 * Autumn customer ids may only contain letters, numbers, underscores
 * and hyphens. Bluesky DIDs (e.g. `did:plc:abc123`) contain colons,
 * so we replace `:` with `_` for the Autumn-side identifier. The
 * mapping is stable and reversible.
 */
export function didToCustomerId (did:string):string {
    return did.replace(/:/g, '_')
}

function client (env:BillingEnv):Autumn {
    if (!env.AUTUMN_SECRET_KEY) {
        throw new Error(
            'autumn-billing: AUTUMN_SECRET_KEY is not configured'
        )
    }
    return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY })
}

export async function getOrCreateCustomer (
    env:BillingEnv,
    did:string,
    name?:string,
    email?:string
):Promise<void> {
    await client(env).customers.getOrCreate({
        customerId: didToCustomerId(did),
        name: name ?? null,
        email: email ?? null
    })
}

/**
 * Fetch the customer's stored email. Returns null when the customer
 * doesn't exist or has no email yet.
 */
export async function getCustomerEmail (
    env:BillingEnv,
    did:string
):Promise<string|null> {
    const customer = await client(env).customers.getOrCreate({
        customerId: didToCustomerId(did)
    })
    return customer.email ?? null
}

export interface AttachedCheckout {
    paymentUrl:string|null;
}

export async function attachCheckout (
    env:BillingEnv,
    did:string,
    planId:BillingPlanId,
    successUrl:string
):Promise<AttachedCheckout> {
    const res = await client(env).billing.attach({
        customerId: didToCustomerId(did),
        planId,
        successUrl
    })
    return { paymentUrl: res.paymentUrl ?? null }
}

export interface VerifiedSubscription {
    planId:string;
    status:'active'|'scheduled';
}

function isVerifiedSubscriptionStatus (
    status:unknown
):status is VerifiedSubscription['status'] {
    return status === 'active' || status === 'scheduled'
}

/**
 * Re-fetch the customer with subscriptions expanded and assert
 * an active or scheduled non-add-on subscription matching planId.
 * Returns null if no such subscription exists.
 */
export async function verifySubscription (
    env:BillingEnv,
    did:string,
    planId:BillingPlanId
):Promise<VerifiedSubscription|null> {
    const customer = await client(env).customers.getOrCreate({
        customerId: didToCustomerId(did),
        expand: ['subscriptions.plan']
    })
    const subs = customer.subscriptions ?? []
    for (const s of subs) {
        if (s.planId !== planId) continue
        if (s.addOn) continue
        if (s.canceledAt) continue
        if (!isVerifiedSubscriptionStatus(s.status)) continue
        return { planId: s.planId, status: s.status }
    }
    return null
}

export async function getCustomerPortalUrl (
    env:BillingEnv,
    did:string,
    returnUrl:string
):Promise<string> {
    const res = await client(env).billing.openCustomerPortal({
        customerId: didToCustomerId(did),
        returnUrl
    })
    return res.url
}
