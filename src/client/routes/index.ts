import Router from '@substrate-system/routes'
import { LoginPage } from './login.js'
import { FeedReader } from './feed-reader.js'
import { ItemReader } from './item-reader.js'
import { AboutRoute } from './about.js'
import { State, type AppState } from '../state.js'
import { SettingsRoute } from './settings.js'
import { SignupPage } from './signup.js'
import { PaymentSuccessPage } from './payment-success.js'
import { TermsRoute } from './terms.js'
import { PrivacyRoute } from './privacy.js'
// import Debug from '@substrate-system/debug'
// const debug = Debug('rsss:routes')

// example callback URL
// https://rsss.space/oauth/callback?state=b3QtX4H7oVsGPxIBS_A32Q&iss=https%3A%2F%2Fbsky.social&code=cod-4c9603952c0ee8c3119308ddf4fb39a20e73e62f1985d2b8807365e38b4fee5d

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

    router.addRoute('/signup', () => {
        return SignupPage
    })

    router.addRoute('/payment-success', () => {
        return PaymentSuccessPage
    })

    router.addRoute('/about', () => {
        return AboutRoute
    })

    router.addRoute('/terms', () => {
        return TermsRoute
    })

    router.addRoute('/privacy', () => {
        return PrivacyRoute
    })

    router.addRoute('/settings', () => {
        return SettingsRoute
    })

    router.addRoute('/oauth/callback', () => {
        // If already authenticated, skip the callback
        // and go home -- the OAuth state in KV is likely
        // expired or already consumed.
        if (state.isAuthenticated.value) {
            state._setRoute('/')
            return FeedReader
        }

        // handleOAuthCallback is async; once this route initially returns
        // LoginPage, its network request may finish OAuth and change the
        // active route.
        State.handleOAuthCallback(state)
        return LoginPage
    })

    /**
     * Feed-filtered view
     *   - show items for a single feed, matched by URL
     */
    router.addRoute('/feed/*', () => {
        return FeedReader
    })

    router.addRoute('/post/*', () => {
        return ItemReader
    })

    return router
}

export const routes = [
    { href: '/', text: 'home' },
    { href: '/about', text: 'about' }
]
