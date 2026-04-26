import { test } from '@substrate-system/tapzero'

// Import test modules
import './sync.js'
import './db-adapter.js'
import './server-lww.js'
import './feed-fetch-security.js'
import './feed-parser.js'
import './feed-create.js'
import './do-handlers.js'
import './item-route.js'
import './state-route.js'
import './state-auth-storage.js'
import './debug-storage.js'
import './api-router.js'
import './alarm.js'
import './server-headers.js'
import './autumn-billing.js'
import './email.js'
import './session-cookie.js'
import './feed-cache-column.js'
import './do-migrations.js'
import './header-component.js'
import './sqlite-worker.js'

test('all done', () => {
    if (window) {
        // @ts-expect-error tests
        window.testsFinished = true
    }
})
