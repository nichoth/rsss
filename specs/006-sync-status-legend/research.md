# Phase 0 Research: Sync Status Legend

The spec has no `[NEEDS CLARIFICATION]` markers. The dependencies and
data sources are all already in the project and well-understood. This
document records the small number of design choices made during
planning so that the implementation tasks (Phase 2) can be derived
without re-deriving them.

## R1. Where the label lives

**Decision**: Extend `FeedStatus`
(`src/client/components/feed-status.ts`).

**Rationale**:

- The user described the indicator that today already renders the
  colored dot in the top right of the app header. That component is
  `FeedStatus`. It is already wired into `Header`
  (`src/client/components/header.ts`) and is already driven by
  `state.feedSyncStatus` and `state.feedUpdateCounts`.
- The other "sync" component, `SyncStatus`
  (`src/client/components/sync-status.ts`), tracks DB-level pull/push
  outbox state (`syncStatus`, `syncedAt`, `syncPending`,
  `syncDeadLetters`) and is a separate user story. The feature spec
  is explicit about the colored-dot indicator, which is `FeedStatus`.

**Alternatives considered**:

- New component (`<SyncLegend/>`): rejected. The user's request and
  the spec's "Edge Cases > Other dot colors not covered" are explicit
  that this is a label *for the existing indicator*, not a new
  surface. Adding a sibling component would duplicate the
  `feedSyncStatus`/`feedUpdateCounts` derivation and make the gray
  and red states inconsistent.
- Extend `SyncStatus`: rejected. Different signal set, different
  semantics (DB sync vs. RSS feed refresh), different colors.

## R2. State -> label mapping

**Decision**: One pure function inside the component, returning the
visible text *and* the value to use as the accessible name. The two
strings are always equal for the three covered states; the function
is the single source of truth so they cannot drift.

| `feedSyncStatus` | dot color (existing) | label (new)                     | in scope |
|------------------|----------------------|---------------------------------|----------|
| `synced`         | green                | "up to date"                    | yes (FR-002) |
| `updates`        | blue                 | "1 update" / "`n` updates"     | yes (FR-003) |
| `syncing`        | yellow               | "refreshing"                    | yes (FR-004) |
| `inactive`       | gray                 | (none -- presentation preserved) | no  (FR-007) |
| `error`          | red                  | (existing "sync failed")        | no  (FR-007) |

**Rationale**: A literal mapping is the smallest, most readable
implementation, and makes singular/plural for `updates` a tiny
branch rather than a localization lib. FR-006 demands visible-text
parity with `aria-label`, which is trivial when both are derived
from the same expression.

**Alternatives considered**:

- `Intl.PluralRules`: rejected. Localization is explicitly out of
  scope (spec "Assumptions"). Pulling in a runtime locale would add
  weight for zero benefit at v1.
- Storing the mapping in `state.ts`: rejected. The strings are pure
  presentation, not state, and putting them in `state.ts` would
  invite cross-component coupling.

## R3. Narrow-viewport behavior

**Decision**: Always emit the text in the DOM. At narrow viewports
where the new label would push the right cluster (`SyncStatus`,
`FeedStatus`, Logout, `UserIcon`) into wrapping or overflow, hide the
text node with CSS (`@media`) while keeping the dot visible. The
`aria-label` continues to expose the full sentence, so screen
readers are unaffected (FR-006, "Narrow viewports" edge case).

**Rationale**:

- The header already switches to a hamburger menu at `width < 680px`
  (existing media query in `header.css`). The new text will be
  visible above that breakpoint; we will only need a tighter rule if
  the new text causes wrapping in the 680-1000px range.
- Keeping the text in the DOM (rather than conditionally rendering)
  avoids triggering hydration / signal re-runs purely to add a
  string. CSS `display: none` is sufficient because the visible
  label and `aria-label` are independent surfaces.

**Alternatives considered**:

- Tooltip on hover: rejected. FR-008 forbids requiring hover.
- Conditional render based on `window.innerWidth`: rejected. Couples
  the component to viewport listeners and breaks SSR if added later.

## R4. Reactivity guarantee

**Decision**: No new code path. `state.feedSyncStatus` and
`state.feedUpdateCounts` are Preact signals already consumed by
`FeedStatus`; reading them inside the component's render body is
sufficient for FR-005 (reactive updates without manual refresh).

**Rationale**: The existing component already re-renders on each
state transition. Adding a new derived string in the same render does
not change the subscription set.

## R5. Tests

**Decision**:

- Unit-style test for the per-state label function (synced /
  updates with n=1 / updates with n>1 / syncing). Place under
  `test/client/feed-status.test.ts` (or wherever sibling client
  tests already live; verify during Phase 2).
- A browser sanity check, per the constitution's "Local
  verification" gate: load the app, force the three states (e.g.
  via the existing dev controls or by mutating the signals from the
  console) and read the label.

**Rationale**: The label-building function is the only branchy part
of the change; covering it in isolation avoids spinning up a
component test harness purely for string assembly. The browser check
is non-negotiable per constitution.

**Alternatives considered**:

- Full Preact component-render test: deferred. May add later if the
  branch logic grows; for v1 a pure-function test is enough.
