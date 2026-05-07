import { UserDO } from '../src/server/durable-objects/index.js'

// Test fixture: per-account bookkeeping helpers no-op (writes) /
// return undefined (reads) when a test harness omits `ctx.storage`.
// Production always has `ctx.storage` via the Cloudflare runtime, so
// this only relaxes test-side requirements; tests that want to
// verify the bookkeeping continue to attach their own storage stub
// and observe writes through it.

interface DoCtx { storage?:unknown }
type ReadHelper<T> = (this:{ ctx:DoCtx }, ...args:unknown[]) =>
    Promise<T|undefined>
type WriteHelper = (this:{ ctx:DoCtx }, ...args:unknown[]) =>
    Promise<void>
const proto = UserDO.prototype as unknown as Record<
    string,
    (...args:unknown[]) => Promise<unknown>
>
const writeKeys = [
    'writeLastAnySuccess',
    'writeAccountActivity',
    'writePollerFeedState',
    'deletePollerFeedState'
]
for (const key of writeKeys) {
    const orig = proto[key] as WriteHelper|undefined
    if (!orig) continue
    proto[key] = async function (
        this:{ ctx:DoCtx },
        ...args:unknown[]
    ) {
        if (!this.ctx || !this.ctx.storage) return
        return orig.call(this, ...args)
    } as unknown as (...args:unknown[]) => Promise<unknown>
}
const readKeys = [
    'readLastAnySuccess',
    'readAccountActivity',
    'readPollerFeedState'
]
for (const key of readKeys) {
    const orig = proto[key] as ReadHelper<unknown>|undefined
    if (!orig) continue
    proto[key] = async function (
        this:{ ctx:DoCtx },
        ...args:unknown[]
    ) {
        if (!this.ctx || !this.ctx.storage) return undefined
        return orig.call(this, ...args)
    } as unknown as (...args:unknown[]) => Promise<unknown>
}
