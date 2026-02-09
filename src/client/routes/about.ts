import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { EM_DASH, NBSP } from '../constants.js'
import { type AppState } from '../state.js'
import './about.css'

export const AboutRoute:FunctionComponent<{
    state:AppState
}> = function ({ state: _state }) {
    return html`<div class="route about">
        <header class="about-header">
            <a href="/" class="back-link">${'<'} Back to feeds</a>
        </header>

        <article class="about-content">
            <h1>About RSSS</h1>
            <p class="tagline">Really Simple Syndication Service</p>

            <section>
                <h2>What is this?</h2>
                <p>
                    RSSS is an <a href="https://en.wikipedia.org/wiki/RSS">
                    RSS/Atom</a> feed reader built as a${NBSP}
                    <a href="https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps">
                        Progressive Web App (PWA)
                    </a>. It lets you subscribe to feeds
                    and read them in one place, and save content for
                    offline reading. You can sign in with a${NBSP}
                    <a href="https://bsky.app/">Bluesky</a> account.
                </p>
            </section>

            <section>
                <h2>How it works</h2>

                <h3>Architecture</h3>
                <p>
                    RSSS is a simplified local-first app. <em>Simplified</em>
                    ${NBSP}because the local data is a read-only replica of the
                    server-side state. Any write operations require you to be
                    online.
                </p>
                <p>
                    The server periodically polls the feeds you are
                    subscribed to, and the client has manual sync only
                    (you have to click the button).
                </p>

                <p>
                    This does depend heavily on${NBSP}
                    <a href="https://developers.cloudflare.com/durable-objects/">
                        Cloudflare Durable Objects
                    </a> ${EM_DASH + ' '}
                    each user gets their own Durable Object with a SQLite
                    database. This stores your feeds, items, read/starred
                    states, and handles periodic feed fetching. The server
                    is the ultimate source of truth.
                </p>

                <p>
                    A local copy of each feed can optionally be stored in${NBSP}
                    <a href="https://developer.mozilla.org/en-US/docs/Glossary/IndexedDB">
                        IndexedDB</a> for offline access.
                </p>

                <h3>Syncing</h3>
                <p>
                    We use timestamp-based incremental sync to keep local
                    and remote data in sync:
                </p>
                <ol>
                    <li>
                        On first load, the client fetches all data from the
                        server.
                    </li>
                    <li>
                        If feeds have been configured for offline storage,
                        then on subsequent loads, the client sends a "since"
                        timestamp and only receives records that changed
                        since then.
                    </li>
                    <li>
                        When you perform actions (mark as read, star, etc.), the
                        change is sent to the server immediately. You must be
                        online to perform <em>write </em> operations.
                    </li>
                    <li>
                        The server periodically polls your feeds (every 10
                        minutes) to check for new items.
                    </li>
                </ol>

                <h3>Offline support</h3>
                <p>
                    As a PWA, RSSS can be installed to your home screen and
                    works offline. When offline, you can read cached items.
                </p>
            </section>

            <section>
                <h2>Privacy</h2>
                <p>
                    Your feeds and reading history are private to you. The only
                    data shared is what's necessary for Bluesky OAuth.
                    Feed content is fetched server-side, so the websites
                    you subscribe to don't see your IP address.
                </p>
                <p>
                    Note that nothing here is encrypted. You <em>are</em> taking
                    it at my word that I am not reading your RSS subscription
                    data, and no one at Cloudflare is either.
                </p>
            </section>

            <section>
                <h2>Status</h2>
                <p>
                    RSSS is open source. View the code or report issues
                    on <a
                        href="https://github.com/nichoth/rsss"
                        target="_blank"
                        rel="noopener"
                    >GitHub</a>.
                </p>

                <p>
                    This is considered to be "alpha" quality software at
                    this point.
                </p>
            </section>
        </article>
    </div>`
}
