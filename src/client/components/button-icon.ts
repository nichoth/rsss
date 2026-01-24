import { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { type ButtonProps, Button } from './button.js'

export const ButtonIcon:FunctionComponent<ButtonProps> = function (props) {
    return html`<${Button} ...${props} class="btn-icon${props.class || ''}">
        ${props.children}
    <//>`
}
