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
            <a href="/" class="back-link">
                ${'<'} Back to feeds
            </a>
        </header>

        <article class="about-content">
            <h1>About RSSS</h1>
            <p class="tagline">
                Really Simple Syndication Service
            </p>

            <section>
                <h2>What is this?</h2>
                <p>
                    RSSS is an <a href="https://en.wikipedia.org/wiki/RSS">
                    RSS/Atom</a> feed reader. It lets you subscribe
                    to feeds and read them in one place. You can
                    sign in with a${NBSP}
                    <a href="https://bsky.app/">Bluesky</a>
                    account.
                </p>
            </section>

            <section>
                <h2>How it works</h2>

                <h3>Architecture</h3>
                <p>
                    This depends on${NBSP}
                    <a href="https://developers.cloudflare.com/durable-objects/">
                        Cloudflare Durable Objects
                    </a> ${EM_DASH + ' '}
                    each user gets their own Durable Object
                    with a SQLite database. This stores your
                    feeds, items, read/starred states, and
                    handles periodic feed fetching.
                </p>

                <p>
                    The server periodically polls the feeds
                    you are subscribed to (every 10 minutes)
                    to check for new items.
                </p>
            </section>

            <section>
                <h2>Local</h2>
                <p>
                    The end-goal for this is to fully support offline
                    reading. That is, provide and intuitive UI to control
                    which feeds are saved locally, and which are saved in the
                    cloud only.
                </p>

                <p>
                    That's on the todo list though, because I do not want
                    to release a bad UX, and it's hard to devote a lot of time
                    to this, since it is not a job.
                </p>
            </section>

            <section>
                <h2>Privacy</h2>
                <p>
                    Your feeds and reading history are private
                    to you. The only data shared is what's
                    necessary for Bluesky OAuth. Feed content
                    is fetched server-side, so the websites
                    you subscribe to don't see your IP address.
                </p>
                <p>
                    Note that nothing here is encrypted.
                    You <em>are</em> taking it at my word that
                    I am not reading your RSS subscription
                    data, and no one at Cloudflare is either.
                </p>
            </section>

            <section>
                <h2>Status</h2>
                <p>
                    RSSS is open source. View the code or
                    report issues on <a
                        href="https://github.com/nichoth/rsss"
                        target="_blank"
                        rel="noopener"
                    >GitHub</a>.
                </p>

                <p>
                    This is considered to be "alpha" quality
                    software at this point, hence the donation links.
                </p>
            </section>
        </article>
    </div>`
}
