import { html } from 'htm/preact/index.js'
import { type FunctionComponent } from 'preact'
import './oauth-loader.css'

export const OAuthCallbackLoader:FunctionComponent = function () {
    return html`
        <div class="oauth-callback-loader" aria-busy="true">
            <p role="status">
                <span
                    class="oauth-callback-loader-spinner"
                    aria-hidden="true"
                ></span>
                <span class="oauth-callback-loader-label">
                    Signing in…
                </span>
            </p>
        </div>
    `
}
