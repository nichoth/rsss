import { html } from 'htm/preact'
import Router from '@substrate-system/routes'
import { HomeRoute } from './home.js'

export default function _Router ():ReturnType<Router> {
    const router = new Router()

    router.addRoute('/', () => {
        return HomeRoute
    })

    router.addRoute('/aaa', () => {
        return () => {
            return html`<h2>aaa</h2>`
        }
    })

    router.addRoute('/bbb', () => {
        return () => {
            return html`<h2>bbb</h2>`
        }
    })

    router.addRoute('/ccc', () => {
        return () => {
            return html`<h2>ccc</h2>`
        }
    })

    return router
}
