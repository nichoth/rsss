import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'
import { type AppState } from '../state'
import './settings.css'

export const SettingsRoute:FunctionComponent<{
    state:AppState
}> = function (props) {
    const { state } = props

    return html`<div class="route settings">
        Settings here
    </div>`
}
