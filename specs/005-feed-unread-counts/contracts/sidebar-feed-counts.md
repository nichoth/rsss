# Contract: Sidebar Feed Counts (rendered behavior)

**Branch:** `005-feed-unread-counts`
**Surface:** internal client UI (Preact component)
**Component:** `Sidebar` — `src/client/components/sidebar.ts`

This feature is rendered inside the existing `Sidebar` component
(not in `SidebarItem`, which renders the upper "All Items" / "Starred"
rows and is out of scope). The contract pins the rendered behavior
of the feed list because that is what acceptance scenarios in
`spec.md` test against.

## Inputs (props + signal subscriptions)

`Sidebar` already takes `state:AppState`. During render it reads:

- `state.feeds.value` — `Feed[]`, the subscribed feed list.
- `state.feedsLoading.value` — `boolean`, gates the loading text.
- `state.route.value` — `string`, drives the `active` styling on the
  current feed row (existing).
- `state.counts.value` — `{ unread, starred, total, perFeed }` (NEW
  `perFeed` field consumed here for the first time).

`SidebarItem` (the inner component used by the upper section) is
**not** modified by this feature.

## Output

For each row in the feeds-list section of the sidebar, the rendered
output includes a numeric leading badge.

### "All Feeds" row (pseudo-feed, `href="/"`)

```
[count]   All Feeds
```

`count = state.counts.value.unread` (already in the signal). Renders
the integer including `0`.

### Per-feed rows (one per element of `state.feeds.value`)

```
[count]   <feed.title || feed.url>     [delete button]
```

`count = state.counts.value.perFeed[String(feed.id)] ?? 0`. Renders
the integer including `0`.

## DOM contract (testable)

Each feed row in `.feeds-list .feed-item` MUST contain a child
element with class `.badge` (or `.feed-unread-count` — implementer's
choice) whose text content is the integer count. The badge MUST
appear before the feed name in DOM order so that visual placement
ends up to the **left** of the feed name in LTR layouts (FR-002).
Layout fine-tuning can flip this with `flex-direction: row` and
explicit child order; the DOM order is the canonical anchor.

```html
<div class="sidebar-item feed-item">
  <span class="badge feed-unread-count">7</span>
  <a class="feed-select" href="/feed/...">Example Feed</a>
  <div class="item-controls">...</div>
</div>
```

The "All Feeds" row is the same shape minus the delete control:

```html
<div class="sidebar-item feed-item">
  <span class="badge feed-unread-count">11</span>
  <a class="feed-select" href="/">All Feeds</a>
</div>
```

## Reactivity contract

1. **Settled rendering (FR-001 / FR-010 / SC-001):** When the
   sidebar renders, every feed row and the "All Feeds" row contain a
   `.badge` (or `.feed-unread-count`) element with non-empty integer
   text content.
2. **Mutation refresh (FR-005):** Mutations that change unread state
   MUST continue to call `State.loadCounts(state)` after they
   resolve. This is already true for `toggleItemRead`,
   `toggleItemStarred`, `markAllRead`. No new caller is introduced.
3. **Sync refresh (FR-006):** `State.refreshAfterSync(state)` MUST
   continue to call `State.loadCounts(state)`. This is what the
   `feed-updated` SSE handler ultimately reaches via
   `scheduleRefresh()`.
4. **Add/delete refresh (FR-007):** `State.addFeed` and
   `State.deleteFeed` MUST continue to call `State.loadCounts(state)`
   after their adapter calls resolve, so the new row appears with a
   count and the deleted row disappears.
5. **Filter independence (FR-009):** Toggling
   `state.showUnreadOnly` MUST NOT cause any per-feed badge or the
   "All Feeds" badge to change value. The producer of `counts` does
   not consult `showUnreadOnly`, and the renderer does not read it.

## Boundary cases

- A feed in `state.feeds.value` that is **missing** from
  `counts.value.perFeed` renders `0` (FR-004). This happens both
  when the feed truly has zero unread items and when the feed was
  added after the most recent `loadCounts` round-trip; in both
  cases the next `loadCounts` settles the count.
- Initial render with no auth / no data: `counts.value.perFeed`
  defaults to `{}` (set when the signal is created in
  `state.ts`); per-feed rows render `0`. "All Feeds" renders the
  initial `unread: 0`. This is acceptable: pre-auth there are no
  feed rows to render anyway.
- Large numbers render as plain integers; no truncation, no
  abbreviation (Spec Assumptions / Edge Cases).

## Accessibility / a11y

The per-feed badge is rendered inline with its feed link. The link
is the existing `<a class="feed-select">`; the badge is a sibling
`<span>`. Screen readers will read the count and then the feed
title in DOM order, which matches the visual reading order. No
`aria-live` region is required: counts update as the direct result
of a user action (mark read/unread, refresh) on the same screen.
The "All Feeds" link similarly precedes its content with the count.

## Non-changes (explicit)

- `SidebarItem` (`src/client/components/sidebar-item.ts`) is
  unchanged. The upper sidebar section ("All Items", "Starred")
  is out of scope per spec Assumptions.
- The "Unread only" reading-list checkbox handler in
  `feed-reader.ts` is unchanged.
- Feed-row layout outside the count (delete button, feed-select
  link) is unchanged.
- `DbAdapter` interface signatures other than the added `perFeed`
  field on `CountsResponse` are unchanged.
