import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { EM_DASH, NBSP } from '../constants.js'
import { type AppState } from '../state.js'
import './terms.css'

const LAST_UPDATED = '2026-04-26'

export const PrivacyRoute:FunctionComponent<{
    state:AppState
}> = function ({ state: _state }) {
    return html`<div class="route legal privacy">
        <header class="legal-header">
            <a href="/" class="back-link">
                ${'<'} Back to feeds
            </a>
        </header>

        <article class="legal-content">
            <h1>Privacy Policy</h1>
            <p class="legal-meta">
                Last updated: ${LAST_UPDATED}
            </p>

            <section>
                <h2>The short version</h2>
                <p>
                    Your data is private by default. RSSS
                    does not sell, share, or use your
                    reading data for advertising, training,
                    or analytics. Feeds are fetched
                    server-side so the websites you read
                    don't see your IP address. The only
                    third parties that touch your data are
                    the ones strictly needed to run the
                    service${EM_DASH + ' '}listed below.
                </p>
                <p>
                    Note that nothing here is encrypted at
                    rest. You are taking it on trust that
                    the Operator does not read your
                    subscription data, and that no one at
                    the underlying infrastructure
                    providers does either.
                </p>
            </section>

            <section>
                <h2>Who we are</h2>
                <p>
                    RSSS (the${NBSP}"Service") is operated
                    by an individual (the${NBSP}"Operator")
                    on a best-effort basis. It is not a
                    company. The source code is available
                    on${NBSP}
                    <a
                        href="https://github.com/nichoth/rsss"
                        target="_blank"
                        rel="noopener"
                    >GitHub</a>.
                </p>
            </section>

            <section>
                <h2>What we collect</h2>

                <h3>From your Bluesky account (via OAuth)</h3>
                <ul>
                    <li>
                        Your DID (Bluesky decentralized
                        identifier)
                    </li>
                    <li>Your handle (e.g. <code>name.bsky.social</code>)</li>
                    <li>Your avatar URL</li>
                    <li>
                        OAuth tokens issued by Bluesky,
                        used to verify your identity
                    </li>
                </ul>
                <p>
                    We do not request access to your
                    posts, follows, or any other Bluesky
                    data beyond what is needed to confirm
                    you are who you say you are.
                </p>

                <h3>Things you create in the app</h3>
                <ul>
                    <li>The list of feeds you subscribe to</li>
                    <li>
                        Cached items fetched from those
                        feeds
                    </li>
                    <li>
                        Read/unread and starred state for
                        items
                    </li>
                    <li>
                        App settings (e.g. local-first
                        toggle)
                    </li>
                </ul>

                <h3>If you sign up for a paid tier</h3>
                <ul>
                    <li>
                        The email address you provide for
                        billing
                    </li>
                    <li>
                        Subscription / entitlement state
                        (held by Autumn and Stripe; see
                        below)
                    </li>
                </ul>
                <p>
                    Payment card details are handled
                    entirely by Stripe via Autumn${EM_DASH + ' '}
                    they never reach our servers.
                </p>

                <h3>Operational data</h3>
                <ul>
                    <li>
                        A signed session cookie that lets
                        you stay logged in. It is
                        <code>HttpOnly</code>,
                        <code>Secure</code>, and
                        <code>SameSite</code>-restricted.
                    </li>
                    <li>
                        Standard server logs from
                        Cloudflare (request IPs,
                        timestamps, error traces). These
                        are retained only as long as
                        Cloudflare's defaults dictate and
                        are used for debugging and abuse
                        prevention.
                    </li>
                </ul>
                <p>
                    The Service does not run any
                    third-party analytics, ad, or tracking
                    scripts.
                </p>
            </section>

            <section>
                <h2>How feeds are fetched</h2>
                <p>
                    Feeds you subscribe to are fetched by
                    the server, not by your browser. The
                    feed publisher sees a request from
                    Cloudflare's network, not from you.
                    Each user's feeds are stored in a
                    separate Cloudflare Durable Object
                    with its own SQLite database, keyed
                    to your Bluesky DID.
                </p>
            </section>

            <section>
                <h2>How we use your data</h2>
                <p>Your data is used only to:</p>
                <ul>
                    <li>Sign you in and keep you signed in.</li>
                    <li>
                        Show you the feeds and items you
                        subscribed to, in the state you
                        left them.
                    </li>
                    <li>
                        Periodically poll your feeds (about
                        every 10 minutes) so new items
                        appear.
                    </li>
                    <li>
                        Process billing and send
                        transactional email if you sign
                        up for a paid tier.
                    </li>
                    <li>
                        Diagnose bugs and prevent abuse.
                    </li>
                </ul>
                <p>
                    We do not use your data for
                    advertising, profiling, model
                    training, or sale to third parties.
                </p>
            </section>

            <section>
                <h2>Third parties</h2>
                <p>
                    The Service shares only the data
                    necessary for these providers to do
                    their job:
                </p>
                <ul>
                    <li>
                        <strong>Bluesky</strong> (authentication via AT
                        Protocol OAuth). Bluesky sees that
                        you authorized RSSS.
                    </li>
                    <li>
                        <strong>Cloudflare</strong>
                        (Workers, Durable Objects, KV,
                        and asset hosting). Cloudflare
                        stores all of your app data and
                        sees request metadata.
                    </li>
                    <li>
                        <strong>Autumn</strong> (billing
                        orchestration, only if you sign
                        up for a paid tier). Receives
                        your DID and email address.
                    </li>
                    <li>
                        <strong>Stripe</strong> (payment
                        processing via Autumn, only if
                        you sign up for a paid tier).
                        Receives payment information you
                        enter at checkout.
                    </li>
                    <li>
                        <strong>Resend</strong>
                        (transactional email delivery,
                        only if you sign up for a paid
                        tier). Receives your email address
                        and the contents of billing-related
                        messages we send you.
                    </li>
                </ul>
                <p>
                    Each provider has its own privacy
                    policy that applies to the data it
                    handles.
                </p>
            </section>

            <section>
                <h2>Local-first storage</h2>
                <p>
                    RSSS supports an optional local-first
                    mode that stores feed data in your
                    browser (OPFS / IndexedDB). Anything
                    stored locally stays on your device
                    until you choose to sync it.
                </p>
            </section>

            <section>
                <h2>Cookies</h2>
                <p>
                    The Service uses one cookie:
                    <code>session</code>, a signed token
                    that keeps you logged in. It is set
                    only after you complete the OAuth
                    flow and is removed when you log out.
                    No advertising or tracking cookies
                    are used.
                </p>
            </section>

            <section>
                <h2>Retention</h2>
                <p>
                    Your account data is kept for as long
                    as your account is active. If you
                    request deletion (see below), your
                    Durable Object and its database are
                    removed. Backups, if any, are purged
                    on Cloudflare's standard rotation.
                </p>
            </section>

            <section>
                <h2>Your rights</h2>
                <p>You can:</p>
                <ul>
                    <li>
                        <strong>Access</strong>${NBSP}
                        your data through the app, or by
                        request.
                    </li>
                    <li>
                        <strong>Export</strong>${NBSP}
                        your subscriptions (an OPML
                        export is available where
                        supported).
                    </li>
                    <li>
                        <strong>Delete</strong>${NBSP}
                        your account and associated data
                        by contacting the Operator. A
                        self-serve delete option may be
                        offered in the app.
                    </li>
                    <li>
                        <strong>Object</strong>${NBSP}
                        to processing or
                        <strong>complain</strong> to your
                        local data-protection authority
                        if you believe the Service is
                        mishandling your data.
                    </li>
                </ul>
                <p>
                    Depending on where you live, the
                    GDPR, UK GDPR, CCPA, or similar laws
                    may grant you additional rights. We
                    will honor those rights regardless of
                    where you live.
                </p>
            </section>

            <section>
                <h2>Children</h2>
                <p>
                    The Service is not directed at
                    children under 13 (or the equivalent
                    minimum age in your jurisdiction).
                    Do not use the Service if you are
                    under that age.
                </p>
            </section>

            <section>
                <h2>International transfers</h2>
                <p>
                    Cloudflare and the other providers
                    listed above operate globally. Your
                    data may be processed in countries
                    other than the one you live in. By
                    using the Service you consent to
                    those transfers.
                </p>
            </section>

            <section>
                <h2>Changes</h2>
                <p>
                    This policy may be updated as the
                    Service evolves. The "Last updated"
                    date above will reflect any change.
                    Material changes will be highlighted
                    in the app or by email where
                    practical.
                </p>
            </section>

            <section>
                <h2>Contact</h2>
                <p>
                    For privacy questions or to request
                    deletion of your data, please open an
                    issue on${NBSP}
                    <a
                        href="https://github.com/nichoth/rsss/issues"
                        target="_blank"
                        rel="noopener"
                    >GitHub</a> or contact the Operator
                    through the channels listed there.
                </p>
            </section>
        </article>
    </div>`
}
