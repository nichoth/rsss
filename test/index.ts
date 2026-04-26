import { test } from '@substrate-system/tapzero'

// Import test modules
import './sync.js'
import './db-adapter.js'
import './server-lww.js'
import './feed-fetch-security.js'
import './feed-parser.js'
import './feed-create.js'
import './api-router.js'
import './alarm.js'
import './autumn-billing.js'

test('all done', () => {
    if (window) {
        // @ts-expect-error tests
        window.testsFinished = true
    }
})
