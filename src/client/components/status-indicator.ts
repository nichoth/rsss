import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'

export type StatusType = 'online'|'offline'|'cached'|'remote'

export const StatusIndicator:FunctionComponent<{
    type:StatusType
    title?:string
}> = (props) => {
    const { type, title } = props

    return html`<div class="status-indicator">
        <span
            class="status-indicator ${type}"
            title=${title}
        ></span>
        ${props.children ?
            html`<span class="status-text">
                ${props.children}
            </span>` :
            null
        }
    </div>
    `
}
