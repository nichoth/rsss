import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { EM_DASH, NBSP } from '../constants.js'
import { type AppState } from '../state.js'
import './terms.css'

const LAST_UPDATED = '2026-04-26'

export const TermsRoute:FunctionComponent<{
    state:AppState
}> = function ({ state: _state }) {
    return html`<div class="route legal terms">
        <header class="legal-header">
            <a href="/" class="back-link">
                ${'<'} Back to feeds
            </a>
        </header>

        <article class="legal-content">
            <h1>Terms of Service</h1>
            <p class="legal-meta">
                Last updated: ${LAST_UPDATED}
            </p>

            <section>
                <h2>1. About these terms</h2>
                <p>
                    These terms govern your use of RSSS
                    (the${NBSP}"Service"), an open-source RSS/Atom
                    feed reader hosted at${NBSP}
                    <a href="https://rsss.space">rsss.space</a>.
                    By using the Service you agree to these
                    terms. If you do not agree, please do not
                    use the Service.
                </p>
                <p>
                    The Service is operated by an individual
                    (the${NBSP}"Operator") on a best-effort
                    basis. It is not a company.
                </p>
            </section>

            <section>
                <h2>2. The service</h2>
                <p>
                    RSSS lets you subscribe to RSS and Atom
                    feeds and read items in one place.
                    Authentication is provided by${NBSP}
                    <a
                        href="https://bsky.app/"
                        target="_blank"
                        rel="noopener"
                    >Bluesky</a> via the AT Protocol OAuth
                    flow${EM_DASH + ' '}
                    you must have a Bluesky account to
                    sign in.
                </p>
                <p>
                    A paid tier may be offered for additional
                    features (e.g. cloud sync). Pricing,
                    billing, and refunds for any paid tier are
                    described at the point of purchase.
                </p>
            </section>

            <section>
                <h2>3. Alpha software</h2>
                <p>
                    RSSS is alpha-quality software. It may
                    contain bugs, lose data, change behavior
                    without notice, or become unavailable at
                    any time. Do not rely on it as your only
                    copy of anything you cannot afford to
                    lose.
                </p>
            </section>

            <section>
                <h2>4. Acceptable use</h2>
                <p>You agree not to:</p>
                <ul>
                    <li>
                        Use the Service to violate any law
                        or another person's rights.
                    </li>
                    <li>
                        Attempt to disrupt, overload, or
                        circumvent technical limits of the
                        Service or its underlying
                        infrastructure.
                    </li>
                    <li>
                        Subscribe to or distribute content
                        through the Service that is
                        unlawful, infringing, or that you do
                        not have the right to access.
                    </li>
                    <li>
                        Use the Service to harass, threaten,
                        or harm others.
                    </li>
                    <li>
                        Reverse-engineer or scrape the
                        Service in ways that interfere with
                        other users.
                    </li>
                </ul>
                <p>
                    Because authentication is delegated to
                    Bluesky, you also remain bound by
                    Bluesky's terms of service when using
                    your Bluesky identity here.
                </p>
            </section>

            <section>
                <h2>5. Your content</h2>
                <p>
                    You retain all rights to the feed
                    subscriptions, read/starred state, and
                    any other data you create through the
                    Service. You grant the Operator a
                    limited, non-exclusive license to store
                    and process that data solely for the
                    purpose of operating the Service for
                    you.
                </p>
                <p>
                    Feed content itself belongs to the
                    publishers who produce it and is
                    governed by their own terms.
                </p>
            </section>

            <section>
                <h2>6. Account and termination</h2>
                <p>
                    You may stop using the Service at any
                    time. The Operator may suspend or
                    terminate access at any time, with or
                    without notice, including (but not
                    limited to) for violation of these
                    terms or for operational reasons. Where
                    practical, an attempt will be made to
                    notify you before termination.
                </p>
                <p>
                    You can request deletion of your data
                    at any time${EM_DASH + ' '}see the${NBSP}
                    <a href="/privacy">Privacy Policy</a>.
                </p>
            </section>

            <section>
                <h2>7. Third-party services</h2>
                <p>
                    The Service relies on third parties
                    including Bluesky (authentication),
                    Cloudflare (hosting and storage),
                    Autumn (billing for paid tiers, when
                    enabled), Stripe (payment processing
                    via Autumn), and Resend (transactional
                    email). Their terms and privacy
                    practices apply to the parts of the
                    Service that involve them.
                </p>
            </section>

            <section>
                <h2>
                    8. Disclaimer of warranties
                </h2>
                <p>
                    THE SERVICE IS PROVIDED "AS IS" AND
                    "AS AVAILABLE", WITHOUT WARRANTIES OF
                    ANY KIND, WHETHER EXPRESS OR IMPLIED,
                    INCLUDING WARRANTIES OF
                    MERCHANTABILITY, FITNESS FOR A
                    PARTICULAR PURPOSE, NON-INFRINGEMENT,
                    OR UNINTERRUPTED OR ERROR-FREE
                    OPERATION.
                </p>
            </section>

            <section>
                <h2>9. Limitation of liability</h2>
                <p>
                    TO THE FULLEST EXTENT PERMITTED BY
                    LAW, THE OPERATOR WILL NOT BE LIABLE
                    FOR ANY INDIRECT, INCIDENTAL,
                    SPECIAL, CONSEQUENTIAL, OR PUNITIVE
                    DAMAGES, OR FOR ANY LOSS OF PROFITS,
                    DATA, OR GOODWILL, ARISING OUT OF OR
                    RELATED TO YOUR USE OF THE SERVICE.
                    THE OPERATOR'S TOTAL LIABILITY FOR
                    ANY CLAIM RELATED TO THE SERVICE WILL
                    NOT EXCEED THE GREATER OF (a) THE
                    AMOUNT YOU PAID THE OPERATOR FOR THE
                    SERVICE IN THE 12 MONTHS BEFORE THE
                    CLAIM, OR (b) US$50.
                </p>
            </section>

            <section>
                <h2>10. Indemnity</h2>
                <p>
                    You agree to indemnify and hold the
                    Operator harmless from claims arising
                    out of your use of the Service or
                    your violation of these terms or any
                    applicable law.
                </p>
            </section>

            <section>
                <h2>11. Changes</h2>
                <p>
                    These terms may change over time. The
                    "Last updated" date above will reflect
                    any change. Continued use of the
                    Service after a change means you
                    accept the updated terms.
                </p>
            </section>

            <section>
                <h2>12. Governing law and venue</h2>
                <p>
                    These terms are governed by the laws
                    of the State of Washington, USA,
                    without regard to its conflict-of-laws
                    rules. Any dispute arising out of or
                    relating to these terms or the
                    Service will be brought exclusively
                    in the state or federal courts
                    located in King County, Washington,
                    and you consent to personal
                    jurisdiction there${EM_DASH + ' '}
                    except that either party may bring an
                    individual claim in small-claims
                    court if it qualifies, and except
                    where mandatory consumer-protection
                    law in your country of residence
                    requires otherwise.
                </p>
            </section>

            <section>
                <h2>13. Contact</h2>
                <p>
                    Questions about these terms can be
                    sent by opening an issue on${NBSP}
                    <a
                        href="https://github.com/nichoth/rsss/issues"
                        target="_blank"
                        rel="noopener"
                    >GitHub</a>.
                </p>
            </section>
        </article>
    </div>`
}
