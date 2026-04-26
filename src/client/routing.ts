import type { Signal } from '@preact/signals'
import type { Item } from './db/types.js'
import { linkMatchesItemRoute } from '../shared/item-route.js'

type RouteItemState = {
    items:Signal<Item[]>
}

/**
 * Strip protocol from a URL
 */
export const stripProtocol = function (
    url:string
):string {
    return url.replace(/^https?:\/\//, '')
}

/**
 * Convert an item's link to a route path
 */
export const itemToRoute = function (
    item:Item
):string|null {
    if (!item.link) return null
    try {
        const url = new URL(item.link)
        return '/post/' + url.host +
            url.pathname + url.search + url.hash
    } catch {
        return null
    }
}

/**
 * Check if a route matches an item route pattern
 */
export const isItemRoute = function (
    route:string
):boolean {
    return route.startsWith('/post/')
}

/**
 * Convert a /post/* route to the comparable link fragment
 */
export const routeToItemRoute = function (
    route:string
):string|null {
    if (!isItemRoute(route)) return null
    return route.replace(/^\/post\//, '')
}

/**
 * Find an item by its link matching the current route
 */
export const findItemByRoute = function (
    state:RouteItemState,
    route:string
):Item|null {
    const itemRoute = routeToItemRoute(route)
    if (!itemRoute) return null

    for (const item of state.items.value) {
        const itemRoutePath = itemToRoute(item)
        if (itemRoutePath === route) {
            return item
        }

        if (linkMatchesItemRoute(item.link, itemRoute)) {
            return item
        }
    }
    return null
}
