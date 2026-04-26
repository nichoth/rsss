/**
 * Resend wrapper for billing-related transactional emails.
 *
 * Two events are emitted from the billing flow:
 *   - subscription_started: confirmed entitlement after checkout return
 *   - payment_failed: client signalled that finalizeCheckout retries
 *     were exhausted without an active subscription
 *
 * Both are de-duplicated through the SESSIONS KV so retries and
 * repeated client signals do not double-send.
 *
 * When `useLive` is false (no `RESEND_API_KEY` or `RESEND_DISABLED`
 * is set), the module logs the email payload to the server console
 * instead of calling Resend.
 */
import { Resend } from 'resend'

export interface EmailEnv {
    RESEND_API_KEY?:string;
    RESEND_DISABLED?:string;
    RESEND_FROM?:string;
    NODE_ENV?:string;
}

const DEFAULT_FROM = 'RSSS <noreply@rsss.space>'
const EMAIL_DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 7  // 7 days
const EMAIL_DEDUPE_EPOCH_MS = EMAIL_DEDUPE_TTL_SECONDS * 1000
const EMAIL_RETRY_DELAY_MS = 500

export type BillingEmailEvent =
    | 'subscription_started'
    | 'payment_failed'

export function useLive (env:EmailEnv):boolean {
    if (env.RESEND_DISABLED) return false
    return Boolean(env.RESEND_API_KEY)
}

function fromAddress (env:EmailEnv):string {
    return env.RESEND_FROM || DEFAULT_FROM
}

function client (env:EmailEnv):Resend {
    if (!env.RESEND_API_KEY) {
        throw new Error('email: RESEND_API_KEY is not configured')
    }
    return new Resend(env.RESEND_API_KEY)
}

function dedupeKey (
    did:string,
    planId:string,
    event:BillingEmailEvent
):string {
    const epoch = Math.floor(Date.now() / EMAIL_DEDUPE_EPOCH_MS)
    return `email_sent:${did}:${planId}:${event}:${epoch}`
}

export interface BillingEmailKv {
    get (key:string):Promise<string|null>;
    put (
        key:string,
        value:string,
        options?:{ expirationTtl?:number }
    ):Promise<void>;
}

export interface BillingEmailRetryContext {
    waitUntil (promise:Promise<unknown>):void;
}

function delay (ms:number):Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function isTransientSendError (err:unknown):boolean {
    if (!(err instanceof Error)) return false
    return err.message.includes('statusCode":5')
        || err.message.includes('statusCode":null')
        || err.message.includes('temporarily')
        || err.message.includes('Unable to fetch data')
}

async function sendPayload (
    env:EmailEnv,
    payload:{
        to:string;
        subject:string;
        text:string;
        html:string;
    }
) {
    const result = await client(env).emails.send({
        from: fromAddress(env),
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html
    })

    if (result.error) {
        throw new Error(
            'Resend send failed: ' + JSON.stringify(result.error)
        )
    }
}

/**
 * Returns true if the email was sent (or a no-op log occurred).
 * Returns false if a previous send for the same (did, plan, event)
 * is still within the dedupe window.
 */
async function sendOnce (
    env:EmailEnv,
    kv:BillingEmailKv,
    did:string,
    planId:string,
    event:BillingEmailEvent,
    payload:{
        to:string;
        subject:string;
        text:string;
        html:string;
    },
    retryContext?:BillingEmailRetryContext
):Promise<{ sent:boolean; deduped:boolean }> {
    const key = dedupeKey(did, planId, event)
    const existing = await kv.get(key)
    if (existing) {
        return { sent: false, deduped: true }
    }

    if (!useLive(env)) {
        // Dev path: log the email body so it can be inspected in the
        // server console without a real Resend account.
        console.log(
            `[email/dev] event=${event}` +
            ` to=${payload.to}` +
            ` subject=${JSON.stringify(payload.subject)}\n` +
            payload.text
        )
        await kv.put(key, '1', {
            expirationTtl: EMAIL_DEDUPE_TTL_SECONDS
        })
        return { sent: true, deduped: false }
    }

    try {
        await sendPayload(env, payload)
    } catch (err) {
        if (!isTransientSendError(err)) throw err

        const retry = delay(EMAIL_RETRY_DELAY_MS)
            .then(() => sendPayload(env, payload))
            .then(() => kv.put(key, '1', {
                expirationTtl: EMAIL_DEDUPE_TTL_SECONDS
            }))
            .catch(retryErr => {
                console.error('Resend retry failed:', {
                    did,
                    planId,
                    event,
                    to: payload.to,
                    error: retryErr
                })
            })

        if (retryContext) {
            retryContext.waitUntil(retry)
            return { sent: false, deduped: false }
        }

        await retry
        if (await kv.get(key)) {
            return { sent: true, deduped: false }
        }
        throw err
    }

    await kv.put(key, '1', {
        expirationTtl: EMAIL_DEDUPE_TTL_SECONDS
    })

    return { sent: true, deduped: false }
}

export interface SubscriptionStartedParams {
    to:string;
    did:string;
    planId:string;
    baseUrl:string;
    handle?:string|null;
}

export async function sendSubscriptionStarted (
    env:EmailEnv,
    kv:BillingEmailKv,
    params:SubscriptionStartedParams,
    retryContext?:BillingEmailRetryContext
):Promise<{ sent:boolean; deduped:boolean }> {
    const greeting = params.handle ?
        `Hi @${params.handle},` :
        'Hi,'
    const settingsUrl = new URL('/settings', params.baseUrl).toString()
    const text = [
        greeting,
        '',
        `Your RSSS ${params.planId} subscription is now active.`,
        'Your feeds, read state, and starred items will sync',
        'across all your devices.',
        '',
        'You can manage your subscription any time from Settings:',
        settingsUrl,
        '',
        'Thanks for subscribing,',
        'RSSS'
    ].join('\n')

    const html = [
        '<p>', greeting, '</p>',
        '<p>Your RSSS <strong>',
        escapeHtml(params.planId),
        '</strong> subscription is now active. Your feeds, read',
        ' state, and starred items will sync across all your',
        ' devices.</p>',
        '<p>You can manage your subscription any time from',
        ' <a href="', escapeHtmlAttr(settingsUrl),
        '">Settings</a>.</p>',
        '<p>Thanks for subscribing,<br>RSSS</p>'
    ].join('')

    return sendOnce(
        env,
        kv,
        params.did,
        params.planId,
        'subscription_started',
        {
            to: params.to,
            subject: "You're subscribed to RSSS Sync",
            text,
            html
        },
        retryContext
    )
}

export interface PaymentFailedParams {
    to:string;
    did:string;
    planId:string;
    handle?:string|null;
    signupUrl:string;
}

export async function sendPaymentFailed (
    env:EmailEnv,
    kv:BillingEmailKv,
    params:PaymentFailedParams,
    retryContext?:BillingEmailRetryContext
):Promise<{ sent:boolean; deduped:boolean }> {
    const greeting = params.handle ?
        `Hi @${params.handle},` :
        'Hi,'
    const text = [
        greeting,
        '',
        "We weren't able to confirm a payment for your RSSS",
        `${params.planId} subscription.`,
        '',
        'If your card was declined or the checkout was interrupted,',
        'you can try again here:',
        params.signupUrl,
        '',
        'If you believe you were charged but your account is not',
        "active, reply to this email and we'll sort it out.",
        '',
        'RSSS'
    ].join('\n')

    const html = [
        '<p>', greeting, '</p>',
        "<p>We weren't able to confirm a payment for your RSSS ",
        '<strong>', escapeHtml(params.planId), '</strong>',
        ' subscription.</p>',
        '<p>If your card was declined or the checkout was',
        ' interrupted, you can try again here: ',
        '<a href="', escapeHtmlAttr(params.signupUrl), '">',
        escapeHtml(params.signupUrl),
        '</a>.</p>',
        '<p>If you believe you were charged but your account is',
        " not active, reply to this email and we'll sort it",
        ' out.</p>',
        '<p>RSSS</p>'
    ].join('')

    return sendOnce(
        env,
        kv,
        params.did,
        params.planId,
        'payment_failed',
        {
            to: params.to,
            subject: 'Your RSSS payment did not go through',
            text,
            html
        },
        retryContext
    )
}

function escapeHtml (s:string):string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function escapeHtmlAttr (s:string):string {
    return escapeHtml(s)
}
