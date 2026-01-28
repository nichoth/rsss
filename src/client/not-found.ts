import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'

export const NotFound:FunctionComponent = function () {
    return html`<div class="not-found route">
        <h1>404</h1>
        <p>Page not found</p>
        <a href="/">Go home</a>
    </div>`
}
