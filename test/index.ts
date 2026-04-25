import { test } from '@substrate-system/tapzero'

// Import test modules
import './sync.js'
import './db-adapter.js'
import './server-lww.js'

test('all done', () => {
    if (window) {
        // @ts-expect-error tests
        window.testsFinished = true
    }
})
