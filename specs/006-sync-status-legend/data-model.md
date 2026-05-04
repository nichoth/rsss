# Phase 1 Data Model: Sync Status Legend

This feature adds **no new persisted entities, no new schema, and no
new wire format**. It is a presentational mapping over signals that
already live in `src/client/state.ts`. This document records the
inputs, outputs, and invariants so the Phase 2 task list and any
future reviewer can verify the wiring without re-reading the spec.

## Inputs (existing client signals)

Both signals are populated today by the same code paths
(local-first bootstrap / pull-sync, plus optimistic mutation flows).
The Sync Status Legend reads them; it does not write to them.

### `state.feedSyncStatus`

- **Type**: `Signal<'inactive' | 'updates' | 'syncing' | 'error' | 'synced'>`
- **Defined in**: `src/client/state.ts`
- **Drives**: dot color (existing) and the new visible label.
- **Transitions** (existing, unchanged by this feature):
  - `inactive` -> `syncing` on the first authenticated bootstrap
  - `syncing` -> `synced` when refresh completes with no new items
  - `syncing` -> `updates` when refresh produces cached items the
    client has not yet pulled
  - `synced`/`updates` -> `syncing` on subsequent refresh
  - any -> `error` on a refresh failure surfaced via
    `state.feedSyncError`

### `state.feedUpdateCounts`

- **Type**: `Signal<Record<string, number>>` (feed id -> pending count)
- **Defined in**: `src/client/state.ts`
- **Drives**: the integer rendered inside the "n updates" label.
- **Aggregation rule**: `n = Object.values(feedUpdateCounts.value)
  .reduce((sum, v) => sum + v, 0)`. This matches what `FeedStatus`
  already computes today.

## Output (new presentational mapping)

A pure function `legendFor(status, count): { label, ariaLabel }`
co-located with `FeedStatus`. Both fields equal for in-scope states.

| `status`    | `count` | `label`         | `ariaLabel`                          |
|-------------|---------|-----------------|--------------------------------------|
| `synced`    | (any)   | `"up to date"`  | `"Feed sync status: up to date"`     |
| `updates`   | `1`     | `"1 update"`    | `"Feed sync status: 1 update"`       |
| `updates`   | `> 1`   | `"n updates"`   | `"Feed sync status: n updates"`      |
| `syncing`   | (any)   | `"refreshing"`  | `"Feed sync status: refreshing"`     |
| `inactive`  | (any)   | (no new label -- existing presentation preserved) | (existing) |
| `error`     | (any)   | (no change -- existing "sync failed" preserved)   | (existing) |

The `Feed sync status:` prefix matches the format already used by
`feed-status.ts` for `aria-label`, ensuring AT users keep getting a
self-describing announcement (FR-006).

## Invariants

- **I-1 (visible/AT parity)**: For each in-scope status, the visible
  text and the substring of `aria-label` after `"Feed sync status: "`
  must be byte-identical. (Spec FR-006.)
- **I-2 (count parity)**: When `status === 'updates'`, the integer
  rendered in `label` must equal the aggregated count
  `sum(values(feedUpdateCounts))`. The same value already drives the
  blue dot. (Spec FR-003.)
- **I-3 (zero-count exclusion)**: `count === 0` is unreachable in
  the `updates` state by construction (state machine collapses to
  `synced` when the count clears). The label function does **not**
  need a `0 updates` branch. (Spec Edge Case "Singular vs. plural
  count".)
- **I-4 (out-of-scope preservation)**: The `inactive` and `error`
  branches must not change visible output, color, or `aria-label`.
  (Spec FR-007.)
- **I-5 (no manual refresh)**: The label updates whenever `status`
  or `count` changes, with no extra subscription or `useEffect` wiring
  beyond the signals already read by the component. (Spec FR-005.)

## Out of scope

- Localization / `Intl.PluralRules`.
- Tooltip / hover / focus surfaces.
- `inactive` / `error` copy changes.
- Any backend, DO, or schema work.
