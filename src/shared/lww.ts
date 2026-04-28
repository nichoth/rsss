export type LwwWriteDecision = 'accept' | 'conflict'

export const LWW_EQUAL_TIMESTAMP_RULE = 'client-wins-equal-timestamp'

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
