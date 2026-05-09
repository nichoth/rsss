# Phase 0 Research: Per-Feed Pending Count In Sidebar

## Decision 1: Where in the feed-row DOM does the `(N) ` prefix live?

**Context.** A sidebar feed row currently has this structure
(`src/client/components/sidebar.ts:167-198`):

```html
<div class="sidebar-item feed-item ...">
  <span class="badge feed-unread-count">{feedUnread}</span>
  <a class="feed-select" href="/feed/{feedPath}">
    {feed.title || feed.url}
  </a>
  <div class="item-controls">
    <tool-tip><button class="btn-delete">…</button></tool-tip>
  </div>
</div>
```

The unread badge is a separate flex child sized via
`.feeds-list .feed-item & .feed-unread-count { min-width:3rem; ... }`
in `sidebar.css`. The link is the second flex child and grows to
fill remaining space. Spec FR-006 requires the prefix to appear
"before the feed's display name in the same row, in normal reading
order" and to **not** "replace, reorder, or visually conflict with
the existing per-feed unread count badge or the per-row delete
control."

Two placements satisfy the spec:

- **A. Inside the existing anchor as leading text:**
  `<a class="feed-select">(3) Wired</a>`
- **B. As a separate span between the unread badge and the anchor:**
  `<span class="badge feed-unread-count">5</span>`
  `<span class="pending-prefix">(3) </span>`
  `<a class="feed-select">Wired</a>`

**Decision.** Use **A**: prepend the prefix as leading text inside the
existing `<a class="feed-select">` anchor.

**Rationale.**

1. **Zero new DOM, zero new CSS.** A is a single conditional string
   prepend on the link's text content. B requires a new flex child
   with its own min/max-width / overflow rules — not strictly needed,
   and the global rule "NEVER change CSS that is not related to the
   task" means any new selector adds risk for marginal gain.
2. **Reading order is naturally correct.** Because the prefix is the
   first text node inside the anchor, screen readers announce it
   inline as part of the link's accessible name (e.g. `link, "(3) Wired"`).
   That satisfies FR-008 without any extra ARIA.
3. **Truncation falls on the feed name.** Long feed names already
   truncate via the link's flex width. Prepending the prefix inside
   the same anchor keeps the prefix at the start of the truncatable
   region, so a multi-digit count (Acceptance Scenario 6: `(153)`) is
   rendered fully and any truncation lands on the title — exactly
   what the spec requires.
4. **Click target stays sensible.** Clicking the prefix navigates to
   the feed's reader view (the same target the rest of the link
   already has). That is the intuitive behavior for a label that
   sits inside the feed link.

**Alternatives considered.**

- **Placement B (separate span)** — rejected per (1) above. Would
  require a new flex child and at minimum a `flex-shrink:0` style to
  prevent the prefix from being eaten by the existing
  `min-width:3rem` unread badge under tight widths. Adds complexity
  without unlocking any behavior the spec needs.
- **Replacing the existing `feed-unread-count` badge with a combined
  pending+unread badge** — rejected. The user spec is explicit: the
  format is the parenthesized prefix `(N) ` *before the feed name*.
  The existing unread badge surfaces a different concept (unread
  *opened-able* articles, not pending *fetchable* items) and is out
  of scope per the spec's "Pending Count (per feed)" Key Entity note.
- **Putting the prefix in `aria-label` on the row** — rejected.
  Sighted users see no count, and the spec requires a *visible*
  prefix.

## Decision 2: What signal drives the prefix value?

**Context.** Three signals could plausibly carry per-feed counts:
`counts.perFeed` (existing unread badge), `feedUpdateCounts`
(the SSE-populated pending map), and `feedsWithUpdates` (a derived
list of feed IDs with pending items).

**Decision.** Read `state.feedUpdateCounts.value[String(feed.id)] ?? 0`.

**Rationale.** The aggregate `FeedStatus` pill sums exactly this
signal at `feed-status.ts:74-75`:

```ts
const count = Object.values(state.feedUpdateCounts.value)
    .reduce((sum, value) => sum + value, 0)
```

Spec FR-003 / SC-002 / SC-003 require that the per-feed prefixes
sum to the aggregate at every observable rendering moment, with no
visible drift, including the moment of refresh-clear. The only way
to guarantee that property without a coordinator is to have both
indicators read the same signal — which makes them update in the
same Preact render pass whenever the signal changes (whether the
change is via SSE `feed-updates-available`, via the optimistic clear
inside `refreshFeeds`, or via the post-refresh `refreshAfterSync`
reconcile, all of which already write `feedUpdateCounts` inside a
`batch()`).

**Alternatives considered.**

- `counts.perFeed` — rejected. That field is the *unread* count for
  already-fetched articles, surfaced by the existing
  `feed-unread-count` badge. Wrong concept.
- `feedsWithUpdates` — rejected. It is a derived `string[]` (no
  count), so it can answer "is there pending?" but not "how many?".

## Decision 3: Format details

**Context.** Spec FR-001 fixes the format as `(N) ` followed by the
feed name. The implementation needs to commit to exact spacing and
the zero-handling rule.

**Decision.**

- Prefix string: `(${N}) ` — open paren, count, close paren, single
  ASCII space, no trailing nbsp, no special whitespace. Render
  before any other text inside the anchor.
- Zero-handling: when `N <= 0` or the key is absent from
  `feedUpdateCounts`, render the anchor's children unchanged (no
  prefix at all). Do not render `(0) ` (FR-002, Acceptance
  Scenario 2).
- Display name fallback unchanged: `feed.title || feed.url` — the
  prefix appears before whichever string the existing render uses
  (Edge Case "Feed with no title").

**Rationale.** Single ASCII space matches the user's example
"(3) Wired" verbatim. Non-rendering on zero matches user intent
(spec Assumption: "hiding the prefix avoids visual noise on the
common steady-state where most feeds are caught up"). Reusing the
existing `feed.title || feed.url` expression means the URL-fallback
edge case (some feeds have no title) is handled by construction.

**Alternatives considered.**

- Render as `(0)` for caught-up feeds — rejected by FR-002.
- Render as `[N]` or `N • ` — rejected; spec verbatim requires
  parentheses.

## Decision 4: How are the new tests structured?

**Context.** `test/sidebar-feed-counts.ts` already mounts the real
`Sidebar` component with a stub `AppState` that includes a
`feedUpdateCounts: signal({})` field (line 46), so the file is the
right home for these tests; no new harness is needed.

**Decision.** Extend `test/sidebar-feed-counts.ts` with new cases
covering Acceptance Scenarios 1, 2, 3 (refresh-clears via state
write), 4 (signal change re-renders), 6 (multi-digit), and 7
(deletion does not affect siblings), plus the URL-fallback and
"All Feeds row never gets a prefix" edge cases. Add a
`pendingCounts?:Record<string, number>` field to the existing
`StubOpts` so each test can seed `feedUpdateCounts` directly.

**Rationale.** Co-locating with the existing per-feed-counts test
file keeps the sidebar's render-contract tests in one place, and
reuses the `stubState` / `mount` / `feedRows` helpers. No need for
a separate test file.

**Alternatives considered.**

- A dedicated `test/sidebar-pending-prefix.ts` — rejected; would
  duplicate the existing scaffolding for no benefit.
