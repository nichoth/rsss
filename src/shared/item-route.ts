const HTTP_SCHEME = /^https?:\/\//i

function withoutPostPrefix (route:string):string {
    return route
        .trim()
        .replace(/^\/post\//, '')
        .replace(/^\/+/, '')
}

function addTrailingSlashVariant (
    value:string,
    candidates:Set<string>
):void {
    try {
        const url = new URL(value)
        const original = url.toString()

        if (url.pathname !== '/') {
            url.pathname = url.pathname.endsWith('/') ?
                url.pathname.slice(0, -1) :
                url.pathname + '/'
        }

        const variant = url.toString()
        if (variant !== original) {
            candidates.add(variant)
        }
        return
    } catch {
        // Fall through to string handling for non-URL values.
    }

    const suffixIndex = value.search(/[?#]/)
    const base = suffixIndex === -1 ? value : value.slice(0, suffixIndex)
    const suffix = suffixIndex === -1 ? '' : value.slice(suffixIndex)
    const variantBase = base.endsWith('/') ?
        base.slice(0, -1) :
        base + '/'

    if (variantBase && variantBase !== base) {
        candidates.add(variantBase + suffix)
    }
}

function addSchemeSwap (
    value:string,
    candidates:Set<string>
):void {
    if (value.startsWith('https://')) {
        candidates.add('http://' + value.slice('https://'.length))
    } else if (value.startsWith('http://')) {
        candidates.add('https://' + value.slice('http://'.length))
    }
}

function addCandidateGroup (
    route:string,
    candidates:Set<string>
):void {
    const link = HTTP_SCHEME.test(route) ? route : `https://${route}`

    candidates.add(link)
    addTrailingSlashVariant(link, candidates)
    addSchemeSwap(link, candidates)
}

/**
 * Convert a /post route fragment to exact link candidates.
 */
export function itemRouteCandidates (route:string):string[] {
    const normalized = withoutPostPrefix(route)
    if (!normalized) return []

    const routeForms = new Set<string>()
    routeForms.add(normalized)

    try {
        routeForms.add(decodeURIComponent(normalized))
    } catch {
        // Ignore malformed URI sequences.
    }

    const candidates = new Set<string>()
    for (const routeForm of routeForms) {
        addCandidateGroup(routeForm, candidates)
    }

    return Array.from(candidates)
}

export function linkMatchesItemRoute (
    link:string | null | undefined,
    route:string
):boolean {
    if (!link) return false
    return itemRouteCandidates(route).includes(link)
}
