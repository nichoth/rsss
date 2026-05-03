# Contract: Sidebar Badge — All Items / Starred

**Branch:** `004-unread-only-count`
**Surface:** internal client UI (Preact component)
**Component:** `SidebarItem` — `src/client/components/sidebar-item.ts`

This feature is client-only. There are no public API, CLI, or HTTP
contracts in scope. The contract below pins the rendered behavior of
`SidebarItem` because that is what the user observes and what the
acceptance scenarios in `spec.md` test against.

## Inputs (props + signal subscriptions)

```ts
interface SidebarItemProps {
    state:AppState   // src/client/state.ts AppState
    starred:boolean  // true => "Starred" entry, false => "All Items"
}
```

`SidebarItem` reads, during render, the following signals on `state`:

- `state.counts.value` — `{ unread, starred, total }`
- `state.showUnreadOnly.value` — `boolean`
- `state.showStarredOnly.value` — `boolean` (already used for active
  styling; unchanged by this feature)
- `state.route.value` — `string` (already used for active styling;
  unchanged by this feature)

## Output (rendered badge text)

```
badgeText = (
    starred
        ? state.counts.value.starred
        : (state.showUnreadOnly.value
            ? state.counts.value.unread
            : state.counts.value.total)
)
```

| `starred` | `showUnreadOnly` | badge text source           |
|-----------|------------------|------------------------------|
| `true`    | `false`          | `counts.starred`             |
| `true`    | `true`           | `counts.starred` (unchanged) |
| `false`   | `false`          | `counts.total`               |
| `false`   | `true`           | `counts.unread`              |

The badge always renders a finite non-negative integer (`0` allowed).

## Reactivity contract

1. **Filter toggle (FR-004):** When user code mutates
   `state.showUnreadOnly`, the rendered badge text updates within the
   same Preact tick, without any network call.
2. **Mutation refresh (FR-005):** Callers that mutate item read/star
   state MUST continue to call `State.loadCounts(state)` after the
   mutation resolves. This is already the behavior of
   `State.toggleItemRead`, `State.toggleItemStarred`, and
   `State.markAllRead`. This contract does not introduce new callers.
3. **Sync refresh:** `State.refreshAfterSync` MUST continue to call
   `State.loadCounts(state)` so background sync keeps both `total`
   and `unread` current.

## Non-changes (explicit)

- `DbAdapter.getCounts()` signature is unchanged on both
  `localAdapter` and `remoteAdapter`.
- `CountsResponse` shape is unchanged.
- The `GET /api/items/count` server endpoint is unchanged.
- The "Unread only" checkbox handler in `feed-reader.ts:176-180`
  does NOT need to call `loadCounts()` — `total` and `unread` are
  invariant under filter changes; only the *selection* changes.

## Accessibility / a11y

No change. The badge already renders inside the sidebar `<button>`
and is read as part of that button's accessible name. The numeric
value changing on filter toggle is conveyed through normal
re-render; no `aria-live` region is required because the change is
the direct result of a user action on the same screen.
