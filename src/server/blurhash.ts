export interface BlurhashCacheEntry {
    blurhash:string
    image_width:number
    image_height:number
}

export interface BlurhashJob {
    imageUrl:string
    itemId:number
    objectId:string
}

export async function blurhashCacheKey (imageUrl:string):Promise<string> {
    const encoded = new TextEncoder().encode(imageUrl)
    const digest = await crypto.subtle.digest('SHA-256', encoded)
    const bytes = Array.from(new Uint8Array(digest))
    const hex = bytes.map(byte => {
        return byte.toString(16).padStart(2, '0')
    }).join('')

    return `blurhash:${hex.slice(0, 32)}`
}

export function isBlurhashCacheEntry (
    value:unknown
):value is BlurhashCacheEntry {
    if (!value || typeof value !== 'object') return false

    const entry = value as Partial<BlurhashCacheEntry>

    return typeof entry.blurhash === 'string' &&
        typeof entry.image_width === 'number' &&
        typeof entry.image_height === 'number' &&
        Number.isFinite(entry.image_width) &&
        Number.isFinite(entry.image_height)
}

export function parseBlurhashCacheEntry (
    value:string | null
):BlurhashCacheEntry | null {
    if (!value) return null

    try {
        const parsed = JSON.parse(value) as unknown

        return isBlurhashCacheEntry(parsed) ? parsed : null
    } catch {
        return null
    }
}
