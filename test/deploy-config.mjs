import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const wrangler = readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8'
)
const varsBlock = wrangler.match(/"vars"\s*:\s*\{[\s\S]*?\n\t\}/)?.[0] ?? ''
const queuesBlock = wrangler.match(
    /"queues"\s*:\s*\{[\s\S]*?\n\t\}/
)?.[0] ?? ''
const dlqPattern = [
    /"queue"\s*:\s*"blurhash-jobs"/,
    /[\s\S]*?"dead_letter_queue"\s*:\s*"blurhash-dlq"/
].map((part) => part.source).join('')

assert.doesNotMatch(
    varsBlock,
    /"AUTUMN_SECRET_KEY"\s*:/,
    'AUTUMN_SECRET_KEY must be configured with wrangler secret put, not vars'
)

assert.match(
    wrangler,
    /"binding"\s*:\s*"BLURHASH_KV"/,
    'BLURHASH_KV must be declared as a KV namespace binding'
)

assert.match(
    queuesBlock,
    /"binding"\s*:\s*"BLURHASH_QUEUE"[\s\S]*?"queue"\s*:\s*"blurhash-jobs"/,
    'blurhash-jobs must be bound as the producer queue'
)

assert.match(
    queuesBlock,
    /"queue"\s*:\s*"blurhash-jobs"[\s\S]*?"max_batch_size"\s*:\s*10/,
    'blurhash-jobs consumer must use max_batch_size 10'
)

assert.match(
    queuesBlock,
    /"queue"\s*:\s*"blurhash-jobs"[\s\S]*?"max_batch_timeout"\s*:\s*30/,
    'blurhash-jobs consumer must use max_batch_timeout 30'
)

assert.match(
    queuesBlock,
    /"queue"\s*:\s*"blurhash-jobs"[\s\S]*?"max_retries"\s*:\s*3/,
    'blurhash-jobs consumer must use max_retries 3'
)

assert.match(
    queuesBlock,
    new RegExp(dlqPattern),
    'blurhash-jobs consumer must use blurhash-dlq as the DLQ'
)
