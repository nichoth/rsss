import { html } from 'htm/preact'
import { type FunctionComponent } from 'preact'

export const CacheIcon: FunctionComponent<{
    cached: boolean
}> = ({ cached }) => {
    if (cached) {
        // "Saved" / Local icon (Disk-like)
        return html`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 1.25rem; height: 1.25rem;">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
        `
    }
    // "Cloud" / Remote-only icon
    return html`
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 1.25rem; height: 1.25rem; opacity: 0.5;">
            <path d="M17.5 19c2.5 0 4.5-2 4.5-4.5 0-2.3-1.7-4.2-3.9-4.5C17.6 6.6 14.5 4 11 4 7.9 4 5.2 6.1 4.2 9 2.2 9.4 1 11.1 1 13c0 2.2 1.8 4 4 4h12.5v2z"></path>
        </svg>
    `
}
