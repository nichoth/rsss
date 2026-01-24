import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { type ButtonProps, Button } from './button.js'
import './button-icon.css'

export const ButtonIcon:FunctionComponent<ButtonProps> = function (props) {
    return html`<${Button} ...${props} class="btn-icon${props.class || ''}">
        ${props.children}
    <//>`
}
