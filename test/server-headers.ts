import { test } from '@substrate-system/tapzero'
import { withIsolationHeaders } from '../src/server/isolation-headers.js'

test('asset responses receive isolation headers without mutating immutable',
    async (t) => {
        let res:Response|null = null
        let err:unknown = null

        try {
            const fetched = await fetch('data:text/html,<html></html>')
            res = withIsolationHeaders(fetched)
        } catch (caught) {
            err = caught
        }

        t.equal(err, null, 'does not throw for immutable asset responses')
        t.equal(
            res?.headers.get('Cross-Origin-Opener-Policy'),
            'same-origin',
            'sets COOP header'
        )
        t.equal(
            res?.headers.get('Cross-Origin-Embedder-Policy'),
            'credentialless',
            'sets iframe-compatible COEP header'
        )
    }
)

test('image responses do not receive document isolation headers',
    async (t) => {
        const fetched = await fetch('data:image/png;base64,')
        const res = withIsolationHeaders(fetched)

        t.equal(
            res.headers.get('Cross-Origin-Embedder-Policy'),
            null,
            'image response is left to document credentialless policy'
        )
    }
)
