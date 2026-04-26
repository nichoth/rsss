import { test } from '@substrate-system/tapzero'
import {
    configureDebugStorage,
    DEFAULT_DEBUG
} from '../src/client/debug-storage.js'

test('configureDebugStorage seeds default DEBUG once in dev', t => {
    localStorage.removeItem('DEBUG')

    try {
        configureDebugStorage(true)

        t.equal(
            localStorage.getItem('DEBUG'),
            DEFAULT_DEBUG,
            'sets default namespace when DEBUG is unset'
        )
    } finally {
        localStorage.removeItem('DEBUG')
    }
})

test('configureDebugStorage preserves custom DEBUG in dev', t => {
    localStorage.setItem('DEBUG', 'custom:namespace')

    try {
        configureDebugStorage(true)

        t.equal(
            localStorage.getItem('DEBUG'),
            'custom:namespace',
            'leaves existing custom namespace unchanged'
        )
    } finally {
        localStorage.removeItem('DEBUG')
    }
})

test('configureDebugStorage removes default DEBUG in production', t => {
    localStorage.setItem('DEBUG', DEFAULT_DEBUG)

    try {
        configureDebugStorage(false)

        t.equal(
            localStorage.getItem('DEBUG'),
            null,
            'removes app-seeded default namespace'
        )
    } finally {
        localStorage.removeItem('DEBUG')
    }
})

test('configureDebugStorage preserves custom DEBUG in production', t => {
    localStorage.setItem('DEBUG', 'custom:namespace')

    try {
        configureDebugStorage(false)

        t.equal(
            localStorage.getItem('DEBUG'),
            'custom:namespace',
            'leaves user-customized DEBUG namespace unchanged'
        )
    } finally {
        localStorage.removeItem('DEBUG')
    }
})
