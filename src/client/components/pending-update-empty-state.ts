import { type FunctionComponent } from 'preact'
import { useSignal } from '@preact/signals'
import { html } from 'htm/preact'

export function pendingUpdateLabel (count:number):string {
    if (count === 1) {
        return '1 pending update'
    }
    return `${count} pending updates`
}

export const PendingUpdateEmptyState:FunctionComponent<{
    count:number;
    onRefresh:() => Promise<void>;
}> = function PendingUpdateEmptyState ({ count, onRefresh }) {
    const busy = useSignal<boolean>(false)

    const handleClick = async () => {
        if (busy.value) return
        busy.value = true
        try {
            await onRefresh()
        } finally {
            busy.value = false
        }
    }

    return html`
        <div class="empty-state pending-update-empty-state">
            <p>${pendingUpdateLabel(count)}</p>
            <button
                class="btn btn-small"
                type="button"
                onClick=${handleClick}
                disabled=${busy.value}
            >
                ${busy.value ? 'Refreshing…' : 'Click to refresh'}
            </button>
        </div>
    `
}
