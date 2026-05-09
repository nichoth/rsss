# PRD: Cache Status Indicator Fixes

## Introduction/Overview

The cache status indicator (the "100% cached" / "N uncached" pill in the
header) has two correctness problems that conflict with what users see on
the `/settings` route:

1. **Inconsistent visibility** — the indicator only renders on feed
   reader routes (`/`, `/starred`, `/feed/*`). On `/settings`, `/about`,
   and other authenticated pages it disappears, even though the user is
   still logged in and their cache state still applies.
2. **Misleading state** — when local-first sync is OFF, or when sync is
   ON but the article-content cache is OFF, the indicator still renders
   green "100% cached." This contradicts the `/settings` page, which
   shows "Total storage used: 0 B" and the toggles in their off state.
   It also contradicts the empty-state case where there are simply no
   items yet to cache.

This feature corrects both issues so the indicator is present on every
authenticated route and accurately reflects the user's local-cache
configuration.

## Goals

- Render the cache status indicator on every authenticated route, not
  only feed reader routes.
- Hide the indicator entirely when local storage is unavailable (sync
  off, article cache off, free plan, no local DB).
- Distinguish "no items yet to cache" from "everything cached" with a
  neutral visual state rather than a green "100% cached."
- Eliminate the contradiction between the header indicator and the
  `/settings` cache section so the two views always agree.

## User Stories

### US-001: Show indicator on all authenticated routes
**Description:** As a logged-in user, I want the cache status indicator
visible on every authenticated page so I can monitor my cache state
without navigating back to a feed.

**Acceptance Criteria:**
- [ ] Indicator renders on `/`, `/starred`, `/feed/*`, `/settings`,
      `/about`, `/add-feed`, and any other authenticated route.
- [ ] Indicator does not render on unauthenticated routes
      (login/signup/marketing) — gated by `state.user.value`.
- [ ] Removing the `isFeedReaderRoute` guard does not cause errors on
      routes where `state.selectedFeedId` is null (recompute logic
      already handles `feedId: null`).
- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] Verify in browser using dev-browser skill that indicator appears
      on `/settings` and `/about` in addition to feed reader routes.

### US-002: Hide indicator when article caching is off
**Description:** As a user who has turned off local-first sync or
article caching, I want the cache indicator to disappear so it doesn't
falsely claim my content is cached.

**Acceptance Criteria:**
- [ ] When `syncSubscriptions` is false, indicator returns null.
- [ ] When `syncSubscriptions` is true but `storeContent` is false,
      indicator returns null.
- [ ] Toggling either setting in `/settings` immediately updates the
      header (no manual refresh required).
- [ ] Existing "free / non-entitled user" hide behavior is preserved.
- [ ] Existing "no local DB / not bootstrapped" hide behavior is
      preserved.
- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] Verify in browser using dev-browser skill: toggle off "Sync
      subscriptions and read state to this device" → indicator
      disappears; toggle off "Store article content locally" with sync
      on → indicator disappears.

### US-003: Show neutral empty state for "nothing to cache yet"
**Description:** As a user with sync and article caching enabled but no
items locally yet (fresh install, no feeds added, or all feeds empty), I
want a neutral indicator rather than a misleading "100% cached" so I
understand there is nothing actually cached yet.

**Acceptance Criteria:**
- [ ] When `cacheStatus.totalCount === 0` (and indicator is otherwise
      eligible to render), show a neutral state: gray dot with label
      "No items yet" (or equivalent neutral copy).
- [ ] Neutral state uses gray dot color (reusing the existing `Dot`
      component palette — add gray if not present).
- [ ] Neutral state has appropriate `aria-label` for screen readers.
- [ ] When items exist and all are cached (`uncachedCount === 0` and
      `totalCount > 0`), the existing green "100% cached" state still
      renders.
- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] Verify in browser using dev-browser skill: with sync + article
      cache enabled and no items yet, header shows the gray "No items
      yet" state, not green "100% cached."

### US-004: Indicator state stays consistent with /settings
**Description:** As a user, I want the header indicator and the
`/settings` cache section to never contradict each other so I can trust
both views.

**Acceptance Criteria:**
- [ ] When `/settings` shows "Total storage used: 0 B" with both
      toggles off, the header has no cache indicator at all.
- [ ] When `/settings` shows both toggles on with no items cached, the
      header shows the neutral "No items yet" state.
- [ ] When `/settings` shows both toggles on with items partially
      cached, the header shows the yellow "N uncached" state with
      action button (existing behavior).
- [ ] When `/settings` shows both toggles on with all items cached,
      the header shows green "100% cached" (existing behavior).
- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] Verify in browser using dev-browser skill: walk through all four
      state combinations and confirm header/settings agree in each.

### US-005: Tests cover new visibility and state rules
**Description:** As a developer, I want unit/integration tests that
encode the new visibility and empty-state rules so future regressions
are caught automatically.

**Acceptance Criteria:**
- [ ] Tests in `test/cache-status.ts` cover: indicator hidden when
      `syncSubscriptions` is false; indicator hidden when `storeContent`
      is false; indicator shows neutral empty state when `totalCount`
      is 0 with both toggles on; indicator shows on `/settings` and
      `/about` routes (not just feed reader routes).
- [ ] `npm test` passes.
- [ ] `npm run lint` passes.

## Functional Requirements

- **FR-1:** The cache status indicator must render on every
  authenticated route. The route check `isFeedReaderRoute` must be
  removed from the visibility gate.
- **FR-2:** The indicator must not render when `syncSubscriptions` is
  false.
- **FR-3:** The indicator must not render when `storeContent` is false,
  even if `syncSubscriptions` is true.
- **FR-4:** The indicator must not render for unauthenticated users
  (`state.user.value` is null) — existing behavior preserved.
- **FR-5:** The indicator must not render for users without billing
  entitlement — existing behavior preserved.
- **FR-6:** When the indicator is eligible to render and
  `cacheStatus.totalCount === 0`, it must render a neutral state (gray
  dot, "No items yet" label) rather than green "100% cached."
- **FR-7:** When the indicator is eligible to render and
  `cacheStatus.totalCount > 0` and `uncachedCount === 0`, it must
  render the existing green "100% cached" state.
- **FR-8:** When the indicator is eligible to render and
  `uncachedCount > 0`, it must render the existing yellow "N uncached"
  state with the action popover (no behavior change).
- **FR-9:** Toggling either `syncSubscriptions` or `storeContent` in
  `/settings` must immediately update the header indicator without a
  page refresh. The existing signal-driven reactivity should already
  cover this; the component must subscribe to both signals.
- **FR-10:** `recomputeCacheStatus` should be invoked when
  `storeContent` changes so the snapshot reflects the new effective
  state (or the gate in the component is sufficient — implementer's
  choice as long as the rendered state is correct).

## Non-Goals (Out of Scope)

- No changes to the cache action popover (the "Cache" button and its
  progress UI when `uncachedCount > 0`).
- No changes to the sync indicator or feed status indicator (separate
  components in the header).
- No changes to the `/settings` cache section UI itself; only the
  header indicator is being corrected.
- No new server-side state, schema, or API changes — this is a
  client-rendering correctness fix only.
- No new color tokens beyond what's needed for the gray "neutral" dot
  state (reuse `_variables.css` if a gray already exists).
- No mobile-nav variant of the indicator in this scope (the header
  desktop slot is the only render location today; that does not change
  here).

## Design Considerations

- Reuse the existing `Dot` component for color variants. If gray is not
  already a supported color, add it minimally — re-using an existing
  CSS variable from `_variables.css` per the project's CSS guidelines.
- Neutral-state copy: "No items yet" is the default; use the same
  `cache-status-legend` markup as the current synced state for
  consistent layout.
- ARIA: the neutral state's `aria-label` should be "Cache status: no
  items yet" (or similar) so screen readers do not misreport.
- The visibility predicate should live in `cache-status.ts` (the
  component) — keep `cache-status-state.ts` focused on data, not on
  whether the UI renders.

## Technical Considerations

- `cache-status.ts:75` — remove the `isFeedReaderRoute` guard. Delete
  the helper function if it has no other callers.
- `cache-status.ts:72-78` — extend the gate to also return null when
  `syncSubscriptions.value` or `storeContent.value` is false. Import
  these signals from `../local-first-settings.js`.
- `cache-status.ts:80-91` — split the current "uncachedCount === 0"
  branch into two: `totalCount === 0` (neutral) vs
  `totalCount > 0 && uncachedCount === 0` (green). Confirm
  `cacheStatus.totalCount` is exposed in the snapshot type
  (`CacheStatusSnapshot` already has `totalCount`).
- `cache-status-state.ts:67-73` — the current behavior of writing
  `EMPTY_SNAPSHOT` when local-first is inactive is fine; the component
  hides on the toggle directly, so no change strictly required here,
  but the comment about "100% cached" should be updated to "neutral /
  hidden" to avoid confusion for future readers.
- Per project CLAUDE.md: when sequentially setting multiple signals,
  use `batch()` from `@preact/signals`.
- Per project CLAUDE.md: lines must stay within 80 columns.
- Per global CLAUDE.md: do not change unrelated CSS, do not change
  eslint settings.

## Success Metrics

- Header indicator and `/settings` cache section never contradict each
  other across the four canonical state combinations (sync off /
  article-cache off / empty / partially cached / fully cached).
- No regression in feed reader pages — yellow "N uncached" + action
  popover continues to work exactly as before.
- Test coverage for visibility and empty-state rules added in
  `test/cache-status.ts`.

## Open Questions

- Copy for the neutral state: "No items yet" vs "Nothing to cache" vs
  "0 items" — confirm with design pass. Default to "No items yet"
  unless the user picks otherwise during implementation.
- Should the neutral state be clickable (e.g., link to `/settings`) or
  purely informational? Default to non-interactive for v1.
- If a gray dot color does not yet exist in `_variables.css`, which
  existing neutral/border variable should it reuse? (Implementer's
  judgment, prefer reuse over new variables per project CSS rules.)
