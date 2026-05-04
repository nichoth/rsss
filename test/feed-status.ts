import { test } from '@substrate-system/tapzero'
import { legendFor } from '../src/client/components/feed-status.js'

test('legendFor: synced returns "up to date" for both surfaces', t => {
    const result = legendFor('synced', 0)
    t.equal(result.label, 'up to date', 'visible label for synced')
    t.equal(
        result.ariaLabel,
        'Feed sync status: up to date',
        'aria-label for synced'
    )
})

test('legendFor: updates with count === 1 uses singular', t => {
    const result = legendFor('updates', 1)
    t.equal(result.label, '1 update', 'singular visible label')
    t.equal(
        result.ariaLabel,
        'Feed sync status: 1 update',
        'singular aria-label'
    )
})

test('legendFor: updates with count > 1 uses plural', t => {
    const result = legendFor('updates', 3)
    t.equal(result.label, '3 updates', 'plural visible label')
    t.equal(
        result.ariaLabel,
        'Feed sync status: 3 updates',
        'plural aria-label'
    )
})

test('legendFor: syncing returns "refreshing"', t => {
    const result = legendFor('syncing', 0)
    t.equal(result.label, 'refreshing', 'visible label for syncing')
    t.equal(
        result.ariaLabel,
        'Feed sync status: refreshing',
        'aria-label for syncing'
    )
})

test('legendFor: inactive preserves existing presentation', t => {
    const result = legendFor('inactive', 0)
    t.equal(result.label, '', 'no new visible label for inactive')
    t.equal(
        result.ariaLabel,
        'Feed sync status: inactive',
        'aria-label preserves existing inactive wording'
    )
})

test('legendFor: error preserves existing "sync failed" text', t => {
    const result = legendFor('error', 0)
    t.equal(
        result.label,
        'sync failed',
        'preserves existing error visible text'
    )
})
