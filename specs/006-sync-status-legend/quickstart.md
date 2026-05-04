# Quickstart: Sync Status Legend

Manual verification recipe for the feature. Required by the RSSS
constitution's "Local verification" gate (UI changes must be
exercised in a browser before being claimed complete).

## Prereqs

- Node toolchain installed; `npm install` already run.
- Logged-in test account that has at least one subscribed feed (so
  `feedSyncStatus` can transition out of `inactive`).

## Run

```bash
npm start
```

Open the app in a browser, sign in.

## Verify the three in-scope states

For each row, observe the indicator in the top-right of the header
(the `<FeedStatus/>` slot) and read the label out loud. The text
shown next to the dot must match the spec exactly.

| Trigger | Expected dot | Expected label | Acceptance scenario |
|---------|--------------|----------------|---------------------|
| Steady state, no pending updates | green | `up to date` | Scenario 1 |
| Server has cached exactly 1 unseen item | blue  | `1 update`   | Scenario 2 (n=1 edge) |
| Server has cached `n>1` unseen items   | blue  | `n updates`  | Scenario 2 |
| Click "Refresh" / fire a refresh while watching | yellow | `refreshing` | Scenario 3 |

Easy ways to drive each state without waiting:

- **Force `updates`**: from the browser devtools console, with the
  app loaded and authenticated:
  ```js
  // Replace `state` with the variable name your dev hook exposes,
  // or import { state } in a debug build.
  state.feedUpdateCounts.value = { '1': 3 }
  state.feedSyncStatus.value   = 'updates'
  ```
  Expected label: `3 updates`. Then:
  ```js
  state.feedUpdateCounts.value = { '1': 1 }
  ```
  Expected label: `1 update` (singular).
- **Force `syncing`**: trigger a manual refresh (any feed-refresh
  control), or:
  ```js
  state.feedSyncStatus.value = 'syncing'
  ```
  Expected label: `refreshing`.
- **Force `synced`**: clear the counts and set status:
  ```js
  state.feedUpdateCounts.value = {}
  state.feedSyncStatus.value   = 'synced'
  ```
  Expected label: `up to date`.

## Verify accessible name parity (FR-006)

In Chromium devtools -> Accessibility panel (or Firefox Accessibility
inspector), select the indicator. The "Name" / `aria-label` must
contain the same wording shown visually for each of the three
in-scope states (e.g., for the green dot: a name that includes "up
to date", not just "synced").

Alternative: in the console,
```js
document.querySelector('.feed-status').getAttribute('aria-label')
```
should match the visible text by suffix.

## Verify out-of-scope states are unchanged (FR-007)

- Sign out (or reach `inactive`): the gray dot should render with
  its existing presentation -- no new label was introduced.
- Force an error:
  ```js
  state.feedSyncError.value  = 'simulated'
  state.feedSyncStatus.value = 'error'
  ```
  Expected: red dot with the existing `sync failed` text and the
  existing error `aria-label` and tooltip. No new copy.

## Verify narrow-viewport fallback (Edge Case)

Resize the window. Down to roughly 680px the desktop layout is in
effect. If the right cluster begins to wrap before the existing
hamburger breakpoint kicks in:

- The new text MUST visually disappear (CSS `display: none`).
- The dot remains visible.
- `aria-label` still announces the full sentence.

## Done conditions

- [ ] All three in-scope states render the correct label in the
      browser.
- [ ] `aria-label` matches the visible label for each in-scope state.
- [ ] Singular form (`1 update`) appears when the count is exactly 1.
- [ ] `inactive` and `error` states render exactly as before.
- [ ] No layout jump in the right cluster when the state transitions.
- [ ] `npm test` and `npm run lint` are green.
