import { html } from 'htm/preact/index.js'
import { useState } from 'preact/hooks'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state.js'
import './user-icon.css'

export const UserIcon:FunctionComponent<{
    state:AppState
}> = function ({ state }) {
    const { user } = state
    const [imgFailed, setImgFailed] = useState(false)

    const loggedIn = user.value !== null
    const href = loggedIn ? '/settings' : '/login'
    const avatar = user.value?.avatar
    const showImage = loggedIn && avatar && !imgFailed
    const a11yLabel = loggedIn ?
        `Account settings for @${user.value?.handle}` :
        'Sign in'

    return html`
        <a
            class="user-icon"
            href=${href}
            aria-label=${a11yLabel}
        >
            ${showImage ?
                html`<img
                    src=${avatar}
                    alt=""
                    onError=${() => setImgFailed(true)}
                />` :
                html`<span
                    class="user-icon-placeholder"
                    aria-hidden="true"
                ></span>`
            }
        </a>
    `
}
