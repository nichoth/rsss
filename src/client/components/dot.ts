import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import './dot.css'

export const Dot:FunctionComponent<{
    color?:'gray'|'blue'|'yellow'|'red'|'green'
}> = function (props) {
    const { color } = props
    if (!color) {
        return html`<svg
            class="dot"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 512 512"
        >
            <!--! Font Awesome Free 6.7.2 by @fontawesome
            License: https://fontawesome.com/license/free -->
            <path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512z" />
        </svg>`
    } else {
        return html`<svg
            class="dot ${color}"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 512 512"
        >
            <!--! Font Awesome Free 6.7.2 by @fontawesome
            License: https://fontawesome.com/license/free -->
            <path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512z" />
        </svg>`
    }
}
