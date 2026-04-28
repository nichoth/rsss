export type LwwWriteDecision = 'accept' | 'conflict'

export const LWW_EQUAL_TIMESTAMP_RULE = 'client-wins-equal-timestamp'
const CLIENT_CLOCK_SKEW_LIMIT_MS = 5 * 60 * 1000

export interface ClientUpdatedAtClamp {
    clientUpdatedAt:string
    wasClamped:boolean
}

function parseClientTimestamp (value:string):Date|null {
    const sqliteMatch = value.match(
        /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/
    )
    const date = sqliteMatch
        ? new Date(`${sqliteMatch[1]}T${sqliteMatch[2]}Z`)
        : new Date(value)

    return Number.isNaN(date.getTime()) ? null : date
}

function formatSqliteUtcTimestamp (date:Date):string {
    return date.toISOString().slice(0, 19).replace('T', ' ')
}

export function clampClientUpdatedAt (
    clientUpdatedAt:string,
    now:Date = new Date()
):ClientUpdatedAtClamp {
    const parsed = parseClientTimestamp(clientUpdatedAt)
    if (!parsed) {
        return { clientUpdatedAt, wasClamped: false }
    }

    const maxClientUpdatedAt = new Date(
        now.getTime() + CLIENT_CLOCK_SKEW_LIMIT_MS
    )
    if (parsed.getTime() <= maxClientUpdatedAt.getTime()) {
        return { clientUpdatedAt, wasClamped: false }
    }

    return {
        clientUpdatedAt: formatSqliteUtcTimestamp(maxClientUpdatedAt),
        wasClamped: true
    }
}

/**
 * Server rows win only when their timestamp is strictly newer.
 * Equal timestamps are accepted so replay order has a stable tie-break:
 * the arriving client operation wins.
 */
export function resolveLwwWrite (
    serverUpdatedAt:string|null|undefined,
    clientUpdatedAt:string|undefined
):LwwWriteDecision {
    if (clientUpdatedAt === undefined) return 'accept'
    if (serverUpdatedAt && serverUpdatedAt > clientUpdatedAt) {
        return 'conflict'
    }
    return 'accept'
}
