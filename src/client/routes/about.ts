import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { NBSP } from '../constants.js'
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
                    RSSS is an RSS/Atom feed reader built as a${NBSP}
                    <a href="https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps">
                        Progressive Web App (PWA)
                    </a>. It lets you subscribe to feeds
                    and read them in one place, and save content for
                    offline reading.
                </p>
                <p>
                    You can sign in with a Bluesky account. Each user
                    gets their own isolated instance with their own state.
                </p>
            </section>

            <section>
                <h2>How it works</h2>

                <h3>Architecture</h3>
                <p>
                    RSSS uses a simple version of local-first architecture.
                    Your data lives in two places:
                </p>
                <ol>
                    <li>
                        <strong>Server (Cloudflare Durable Objects)</strong> —
                        Each user gets their own Durable Object with a SQLite
                        database. This stores your feeds, items, read/starred
                        states, handles periodic feed fetching, and is
                        the ultimate source of truth.

                    </li>
                    <li>
                        <strong>Client (IndexedDB)</strong> — A local copy of
                        your data can be stored in your browser for
                        offline access.
                    </li>
                </ol>

                <h3>Syncing</h3>
                <p>
                    We use timestamp-based incremental sync to keep local
                    and remote data in sync:
                </p>
                <ol>
                    <li>
                        On first load, the client fetches all data from the
                        server and stores it locally.
                    </li>
                    <li>
                        On subsequent loads, the client sends a "since" timestamp
                        and only receives records that changed since then.
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
                    Actions taken offline will sync when you reconnect.
                </p>
            </section>

            <section>
                <h2>Privacy</h2>
                <p>
                    Your feeds and reading history are private to you. The only
                    data shared is what's necessary for Bluesky OAuth
                    Feed content is fetched server-side, so the websites
                    you subscribe to don't see your IP address.
                </p>
            </section>

            <section>
                <h2>Open Source</h2>
                <p>
                    RSSS is open source. View the code, report issues, or
                    contribute on <a
                        href="https://github.com/nichoth/rsss"
                        target="_blank"
                        rel="noopener"
                    >GitHub</a>.
                </p>
            </section>
        </article>
    </div>`
}
