# Phase 0 Research: Yellow "Updating" Pill State

The Technical Context section of `plan.md` produced no
`NEEDS CLARIFICATION` markers. The spec is concrete (label,
color, lifecycle binding). This document records the design
choices that were considered before settling on the
"computed-signal" approach in the plan, so the reasoning is
not lost when later features touch the pill.

## Decision 1: How to keep the pill yellow continuously during refresh

**Decision**: Add a computed signal
`state.displayedFeedSyncStatus = computed(() =>
  state.refreshInProgress.value ? 'syncing' :
  state.feedSyncStatus.value)`.
The `FeedStatus` component reads from `displayedFeedSyncStatus`.

**Rationale**:

- A single, derived view over existing signals. No write-time
  coordination between `loadFeedStatus`, the SSE
  `feed-updates-available` listener, the SSE
  `feed-updates-cleared` listener, the manual-refresh path, and
  any future writer. Adding a new writer cannot regress the
  invariant; the pill is only yellow when `refreshInProgress` is
  true.
- The `refreshInProgress` signal already has a precise lifecycle
  contract from feature 010
  (`010-fix-refresh-feedback/contracts/refresh-lifecycle.md`):
  exactly six entry / exit edges, all batched. Binding the pill
  to that signal inherits that contract for free, including the
  "settle-batch with `refreshAfterSync` first" sequencing that
  feature 010 defends with tests.
- Background polling, page-load `loadFeedStatus`, and SSE
  `feed-updates-available` keep `refreshInProgress = false`, so
  they cannot turn the pill yellow even when they overwrite
  `feedSyncStatus`. FR-007 ("yellow is reserved for
  reader-initiated refresh") falls out of the data flow.
- FR-011 ("counts arriving mid-refresh fold into the post-refresh
  resting state") is automatic: writes to `feedUpdateCounts` and
  `feedSyncStatus` during the window are absorbed; the pill
  surfaces them the instant `refreshInProgress` clears.

**Alternatives considered**:

1. *Gate every `feedSyncStatus` writer with
   `if (state.refreshInProgress.value) return`.*
   Rejected. Each writer needs both a guard and an explicit
   "but the settle-time `loadFeedStatus` inside `refreshAfterSync`
   must be allowed to write" exception, otherwise the pill never
   resolves out of yellow. That means an `inSettleReconcile`
   flag (or equivalent), which is exactly the kind of two-source
   state the computed approach removes. It also imposes a
   write-time contract on every future writer.
2. *Introduce a new `pillStatus` signal owned only by the manual
   refresh path, separate from `feedSyncStatus`.*
   Rejected. Splits the source of truth, since the post-refresh
   resting status would then live in a second signal that
   `loadFeedStatus` would have to mirror. Feature 008's
   single-writer invariant for `feedSyncStatus` is the contract
   we want to keep; the right move is a derivation, not a
   second mutable signal.
3. *Hold the pill in `'syncing'` for a minimum-duration window
   (e.g., 250 ms) on click, regardless of `refreshInProgress`.*
   Rejected. The spec edge case "refresh resolves before yellow
   would be perceptible" is already handled in practice because
   the button's busy state and the pill's display are both bound
   to `refreshInProgress`, which the SSE `refresh-complete`
   handler clears in the same `batch` that fires
   `refreshAfterSync`. A click on a zero-feeds account shows
   the yellow pill for at least one paint, which is the bar the
   spec sets. A separate minimum-duration timer would add a
   second source of truth for "is the pill yellow" and could
   keep the pill yellow after the button has gone idle, which
   FR-006 explicitly forbids.

## Decision 2: Where the displayed-status derivation lives

**Decision**: A computed signal in `state.ts`, returned alongside
the existing `feedUpdateStatus` and `feedsWithUpdates` computeds.

**Rationale**:

- Tests can read `state.displayedFeedSyncStatus.value` directly,
  the same way `test/refresh-lifecycle.ts` already reads
  `state.feedSyncStatus.value`. No need to render a component to
  observe pill state.
- The component (`FeedStatus`) stays a pure renderer of the state
  bag — consistent with the rest of the client. Putting the
  derivation inside the component would require the component to
  read two signals and decide the display, which makes
  unit-level testing of "given `refreshInProgress=true`, what
  status would the pill show?" awkward.

**Alternatives considered**:

1. *Derive inside `FeedStatus.tsx`.*
   Rejected for the testability reason above and because it
   couples the component to two signals where one would do.

## Decision 3: Label text — "updating" vs "refreshing"

**Decision**: Change `legendFor('syncing', _)` from
`{ label: 'refreshing', ariaLabel: 'Feed sync status: refreshing' }`
to `{ label: 'updating', ariaLabel: 'Feed sync status: updating' }`.

**Rationale**:

- The spec text is explicit: "the dot should be yellow color, and
  should say 'updating'" (spec input quote) and FR-001 names the
  label as `"updating"`. Spec wording wins over the legacy
  `"refreshing"` text, which was added in feature 008 for a
  different (broader) `'syncing'` semantic.
- "Updating" matches the user's mental model — they clicked a
  button labeled "Refresh Feeds" and the pill says the system is
  updating. "Refreshing" reads as a duplicate of the button.

**Alternatives considered**:

1. *Keep `"refreshing"` to avoid touching downstream string
   matchers.*
   Rejected. The spec specifies a label change; downstream tests
   that match `"refreshing"` already need updating either way and
   are intra-repo, so the cost is one find-and-replace.
2. *Add the literal "Updating " prefix to the count when there is
   one (e.g., "Updating · 3 updates").*
   Rejected. The yellow state masks the count display per
   FR-003; the count is not user-relevant during the in-progress
   phase. Showing both creates the same kind of two-source
   ambiguity this feature is meant to resolve.

## Decision 4: Non-color signal at the medium viewport

**Decision**: Add a `'syncing'` modifier class to the
`.feed-status` wrapper and override the existing
`@media (680px <= width < 1000px) .feed-status .feed-status-legend
{ display: none }` rule so that
`.feed-status.syncing .feed-status-legend` stays visible at all
viewports. The `'up to date'` and `'n updates'` labels continue
to be hidden at the medium viewport so the header still fits.

**Rationale**:

- FR-009 requires a non-color signal so the `'updating'` state is
  distinguishable in high-contrast / color-blind themes. The
  textual label is the simplest non-color cue the design system
  already supports. At the medium viewport the existing rule
  hides every legend, which would leave only the dot — color
  alone. Keeping the legend visible specifically for `'syncing'`
  re-instates the non-color cue without disturbing the layout
  for the resting states (which never need the cue, since the
  presence of the count in the dot's tooltip and the green / blue
  hue agree).
- Reusing the same wrapper class pattern as the existing
  `.feed-status` selector keeps the CSS local and avoids a new
  selector surface.

**Alternatives considered**:

1. *Add a CSS pulse animation to the yellow dot.*
   Rejected as primary fix. Animation can convey "in progress"
   but is also a non-trivial accessibility consideration
   (motion-reduce users would need a fallback) and the spec
   names the label, not animation, as the non-color cue. Could
   be added as a future polish in a separate feature.
2. *Render an icon swap (e.g., a small spinner SVG) instead of
   the static dot when `'syncing'`.*
   Rejected. The dot's shape is a project-wide convention
   (`<Dot color="…" />` is reused elsewhere); changing the SVG
   for one state introduces a special-case render path. The
   label is sufficient.
3. *Always show the legend at all viewports for all states.*
   Rejected. Out of scope; the medium-viewport hide is a
   layout decision from feature 008 and would push other header
   content around. The constitution rule about not modifying
   unrelated CSS applies.

## Decision 5: Removing the redundant `feedSyncStatus = 'syncing'`
write inside `State.refreshFeeds`

**Decision**: Remove the `state.feedSyncStatus.value = 'syncing'`
line from the click-setup `batch` in `State.refreshFeeds`. Keep
`state.feedSyncError.value = null` in the same `batch`. Failure
paths still set `feedSyncStatus = 'error'` (010/011 contract).

**Rationale**:

- With the computed in place the explicit `'syncing'` write is
  redundant for display.
- More importantly, the write is *unsafe* if it stays. Consider
  the path where `refreshAfterSync` rejects without
  `loadFeedStatus` reaching its catch block (e.g.,
  `Promise.all` rejects on `loadItems` while `loadFeedStatus`
  is still pending; the eventual `loadFeedStatus` write may be
  swallowed by the `.catch()` on the outer
  `refreshAfterSync().catch(...)`). In that case the underlying
  `feedSyncStatus` retains the click-time `'syncing'` value
  even after `refreshInProgress = false` clears, leaving the
  pill stuck on yellow with stale text. Removing the click-time
  write means the underlying `feedSyncStatus` retains its
  pre-click resting value across the refresh window; if the
  reconcile fails to update it, the pill exits yellow into the
  pre-click resting state — not the most informative outcome,
  but strictly better than "stuck yellow forever".
- The semantic `'syncing'` value is still used by the failure
  path's own batch, by the 401 branch's existing batch, and by
  any caller of `refreshAfterSync` outside the manual-refresh
  flow that may want to express "we are actively reconciling".
  Those write sites are unchanged.

**Alternatives considered**:

1. *Keep the click-time write and add a defensive
   `feedSyncStatus = 'inactive'` clear in the
   `refresh-complete` settle `.finally()`.*
   Rejected. Two writes in the settle path conflict with the
   "single coherent moment" SC-003 requires; one of them would
   land first and could ghost the other through Preact's
   batching. The cleaner fix is to not write `'syncing'` at all
   on the way in.
2. *Move the `'syncing'` write to a dedicated "settle out of
   yellow" reconcile that runs after `loadFeedStatus` regardless
   of the rest of `refreshAfterSync`.*
   Rejected. This is the same as Decision 1 alternative 1
   reframed — coordinating multiple writers around a flag.
   Computed is simpler.

## Open questions

None. All spec requirements map to the design above with no
residual `NEEDS CLARIFICATION`. The Phase 1 contracts and data
model are defined directly from these decisions.
