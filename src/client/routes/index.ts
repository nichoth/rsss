import Router from '@substrate-system/routes'
import { LoginPage } from './login.js'
import { FeedReader } from './feed-reader.js'
import { AboutRoute } from './about.js'
import { type AppState } from '../state.js'
import { ItemReader } from './item-reader.js'
import { SettingsRoute } from './settings.js'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:routes')

export default function _Router (state:AppState):InstanceType<typeof Router> {
    const router = new Router()

    router.addRoute('/', () => {
        if (!state.authLoading.value && !state.isAuthenticated.value) {
            return state._setRoute('/login')
        }

        return FeedReader
    })

    router.addRoute('/login', () => {
        return LoginPage
    })

    router.addRoute('/about', () => {
        return AboutRoute
    })

    router.addRoute('/settings', () => {
        return SettingsRoute
    })

    /**
     * Item reader route
     *   - fetch the item if we do not have it already
     */
    router.addRoute('/feed/*', () => {
        // fetch the item if we do not have it

        return ItemReader
    })

    return router
}

export const routes = [
    { href: '/', text: 'home' },
    { href: '/about', text: 'about' }
]
