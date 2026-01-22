import { Signal, signal } from '@preact/signals'
import Route from 'route-event'

/**
 * Setup any state
 *   - routes
 */
export function State ():{
    route:Signal<string>;
    count:Signal<number>;
    _setRoute:(path:string)=>void;
} {  // eslint-disable-line indent
    const onRoute = Route()

    const state = {
        _setRoute: onRoute.setRoute.bind(onRoute),
        count: signal<number>(0),
        route: signal<string>(location.pathname + location.search)
    }

    /**
     * set the app state to match the browser URL
     */
    onRoute((path:string, data) => {
        // for github pages
        const newPath = path.replace('/template-ts-preact-htm/', '/')
        state.route.value = newPath
        // handle scroll state like a web browser
        // (restore scroll position on back/forward)
        if (data.popstate) {
            return window.scrollTo(data.scrollX, data.scrollY)
        }
        // if this was a link click (not back button), then scroll to top
        window.scrollTo(0, 0)
    })

    return state
}

State.Increase = function (state:ReturnType<typeof State>) {
    state.count.value++
}

State.Decrease = function (state:ReturnType<typeof State>) {
    state.count.value--
}
