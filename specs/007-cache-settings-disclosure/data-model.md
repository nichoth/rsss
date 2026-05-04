# Phase 1 Data Model: Cache Settings Disclosure (Feed Reader)

This feature adds **no new persisted entities, no new schema, no new
wire format**, and **no new client signal**. It is a presentational
swap of the disclosure widget that wraps the existing per-feed cache
controls. This document records the inputs, the markup contract that
the new widget requires, and the invariants the implementation must
preserve so that Phase 2 task list and any future reviewer can
verify the wiring without re-reading the spec.

## Inputs (existing client state)

All read by the IIFE inside `feed-reader.ts` already; no new reads
introduced.

### `selectedFeed` (local memo)

- **Type**: `FeedRow | null`
- **Source**: derived from `state.feeds` and the route splats inside
  `FeedReader`.
- **Drives**: which feed's cache policy the disclosure is bound to,
  and (via `selectedFeed.id`) the `key` that remounts the disclosure
  on feed switches (Edge Case "no carry-over").

### `feedPolicies` (existing signal)

- **Type**: `Signal<Record<string, FeedCachePolicyRow>>`
- **Defined in**: `src/client/db/feed-cache-policy.ts`
- **Drives**: the summary label (effective mode + `(default)`
  suffix), the cache-mode `<select>`'s selected option, and the
  pre-filled values for max-size and max-age.

### `resolveEffectivePolicy(policy)` (existing pure function)

- **Returns**: `{ cacheMode, maxSizeBytes, maxAgeSeconds, isDefault:
  { cacheMode, ... } }`
- **Drives**: whether to show " (default)" after the mode label
  (FR-004).

### `prefersReducedMotion` (new local boolean, derived)

- **Type**: `boolean`
- **Source**: `window.matchMedia('(prefers-reduced-motion:
  reduce)')`, read once in `useEffect` and updated on the media
  query's `change` event.
- **Drives**: whether the `<details-summary>` element receives
  `duration="0"` (research R4). Lives only in the route's local
  state -- not promoted to `state.ts`.

## Output (markup contract)

The route emits the following subtree in place of the current
`<details class="feed-cache-controls">` block. The element names,
class names, and nesting are required by the
`@substrate-system/details-summary` component (research R2).

```html
<details-summary
    class="feed-cache-controls"
    key="<feed-id>"
    duration="0 if prefers-reduced-motion else absent"
>
    <details>
        <summary>
            Cache:&nbsp;<modeLabel><isDefaultSuffix?/>
        </summary>
        <div class="details-content">
            <div class="feed-cache-form">
                <label class="cache-field-label">
                    Cache mode
                    <select name="feed-cache-mode-<id>">
                        <option value="">Use default</option>
                        <option value="text">Text only</option>
                        <option value="text_images">Text + images</option>
                    </select>
                </label>
                <label class="cache-field-label">
                    Max size (MB, blank = default)
                    <input type="number" name="feed-max-size-<id>" min="1"/>
                </label>
                <label class="cache-field-label">
                    Keep for (days, blank = default)
                    <input type="number" name="feed-max-age-<id>" min="1"/>
                </label>
            </div>
            <button class="btn-clear-cache">Clear cache</button>
        </div>
    </details>
</details-summary>
```

At upgrade time the component injects two extra spans into the
existing `<summary>`; we do not write these, the component does:

```html
<span class="details-summary-icon" aria-hidden="true"></span>
<span class="visually-hidden">expand</span>
```

(Switches to "collapse" while open.)

## Invariants

- **I-1 (markup contract)**: Inside `<details-summary>` there must
  be exactly one `<details>`, one direct-child `<summary>`, and one
  direct-child `<div class="details-content">`. Anything not under
  `.details-content` will not animate and will be measured as part
  of the "closed" height.
- **I-2 (clear-cache placement)**: The "Clear cache" button must
  live inside `.details-content`, **not** as a sibling of
  `.feed-cache-form`. (See research R2 for why.)
- **I-3 (label parity with today)**: The summary text MUST remain
  `Cache: ${modeLabel}` with `' (default)'` appended when the
  effective mode comes from the user default. Existing copy is in
  scope per the spec's Assumptions; do not reword.
- **I-4 (no carry-over on feed switch)**: The
  `<details-summary>` element MUST receive
  `key={selectedFeed.id}` so Preact remounts on switch.
- **I-5 (reduced motion respected)**: When
  `prefers-reduced-motion: reduce` is active, the `duration`
  attribute MUST be set to `"0"`. The disclosure must still toggle
  open/closed -- only the height/opacity tween is suppressed.
- **I-6 (existing cache flow untouched)**:
  `handleFeedCacheModeChange`, `handleFeedMaxSizeChange`,
  `handleFeedMaxAgeChange`, and `handleClearFeedCache` MUST be
  bound to the same elements they are bound to today. No call-site
  signature changes.
- **I-7 (no new signal)**: This feature MUST NOT add a signal to
  `state.ts`. The reduced-motion boolean is local to
  `FeedReader`'s render; the open/closed state is owned by the
  `<details>` element itself (DOM state).
- **I-8 (route scope)**: The Settings route's per-feed cache
  controls (`src/client/routes/settings.ts`) MUST NOT be modified.
  Tests covering `.feed-cache-mode` etc. inside Settings
  (`test/settings-route.ts`) MUST continue to pass unchanged.
- **I-9 (CSS scope)**: All theming overrides MUST be scoped to
  `.feed-cache-controls` (the host class on the
  `<details-summary>`). The global `details-summary` selector and
  `_variables.css` MUST NOT be modified by this feature.
- **I-10 (1rem floor)**: Per project rules, `font-size` of the
  summary, the `<select>`, and the `<input>`s MUST be `>= 1rem`.
  (Today's `.cache-field-label` rule already sets this; the
  component's default summary font-size is `16px` which we override
  to `1rem`.)

## Out of scope

- Settings route cache controls.
- New cache-mode options or copy changes.
- Localization / `Intl` of the summary label.
- Any backend, DO, schema, or sync change.
- Service-worker registration (per Constitution IV).
