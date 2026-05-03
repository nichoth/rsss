import { test } from '@substrate-system/tapzero'

// Import test modules
import './sync.js'
import './sync-cycle.js'
import './db-adapter.js'
import './server-lww.js'
import './feed-fetch-security.js'
import './feed-parser.js'
import './feed-create.js'
import './do-handlers.js'
import './fetch-full-endpoint.js'
import './item-route.js'
import './state-route.js'
import './state-auth-storage.js'
import './api-router.js'
import './alarm.js'
import './server-headers.js'
import './autumn-billing.js'
import './email.js'
import './session-cookie.js'
import './feed-cache-column.js'
import './feed-cache-policy.js'
import './cached-images.js'
import './storage-usage.js'
import './content-storage.js'
import './cache-eviction.js'
import './image-cache.js'
import './do-migrations.js'
import './feed-cursor.js'
import './header-component.js'
import './item-row.js'
import './sidebar-item.js'
import './dot.js'
import './settings-route.js'
import './sqlite-worker.js'
import './local-first-opfs-persistence.js'

test('all done', () => {
    if (window) {
        // @ts-expect-error tests
        window.testsFinished = true
    }
})
