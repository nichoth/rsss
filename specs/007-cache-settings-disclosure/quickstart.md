# Quickstart: Cache Settings Disclosure (Feed Reader)

Manual verification recipe. Required by the RSSS constitution's
"Local verification" gate (UI changes must be exercised in a
browser before being claimed complete).

## Prereqs

- Node toolchain installed; `npm install` already run.
- Logged-in test account with at least one subscribed feed (so the
  feed reader route can render `selectedFeed`).

## Run

```bash
npm start
```

Open the app in a browser, sign in, click into any feed (the URL
should be `/feed/<host>/<path>`).

## Verify the disclosure renders as a control (FR-001)

In the items header, between the feed title and the "Unread only"
checkbox, locate the new disclosure.

- The `Cache: ...` text MUST be visually distinct from plain text:
  cursor changes to `pointer` on hover, an animated `+` icon
  appears at the right edge of the summary, and the icon rotates
  to an `x` when the panel is open.
- DOM check: `document.querySelector('.feed-cache-controls')` MUST
  return a `<details-summary>` element. Inside it MUST be exactly
  one `<details>`, one `<summary>`, and one
  `<div class="details-content">`.

## Verify mouse, touch, and keyboard activation (FR-002, FR-007, SC-003)

For each of the following, the panel MUST toggle and the icon MUST
reflect the new state:

1. Click the summary with the mouse.
2. Tap the summary on a touch device (or with devtools in mobile
   emulation).
3. Tab to the summary -- a visible focus indicator MUST appear --
   then press `Enter`. Repeat with `Space`.

While the panel is open, the visually-hidden toggle hint MUST read
"collapse"; while closed, "expand". (Inspect the second `<span>`
the component injects into `<summary>`.)

## Verify smooth animation and reduced-motion fallback (FR-003, SC-004)

Default state (no reduced-motion preference):

- Open the panel. The height tween should complete in well under
  300 ms with no flicker and no layout jump in the items header.
- Close the panel. Same.

Reduced-motion state:

```bash
# macOS: System Settings -> Accessibility -> Display -> Reduce motion
# OR in DevTools (Chromium):
#   Cmd+Shift+P -> "Emulate CSS prefers-reduced-motion: reduce"
```

Reload the route. Open and close the panel:

- The open/closed state MUST still flip immediately.
- There MUST be NO visible height/opacity tween.

DOM check: while reduced motion is active, the
`<details-summary>` element MUST have attribute `duration="0"`.
While reduced motion is inactive (toggle the emulation off and
reload), the `duration` attribute MUST be absent (the component
defaults to 300 ms).

## Verify summary label tracks effective mode (FR-004)

Open the panel. Change "Cache mode" to "Text only" and blur the
control. The summary label MUST update to `Cache: Text only` (no
`(default)` suffix). Change it back to "Use default". The summary
MUST update to e.g. `Cache: Text + images (default)` (or whatever
matches the user's global default at that moment).

## Verify no regression in the inner controls (FR-005, FR-006, SC-002)

With the panel open, exercise each control once. Each interaction
MUST behave the same as before this feature:

- Cache mode -> "Text only": persists; summary updates.
- Cache mode -> "Use default": persists; `(default)` reappears.
- Max size: enter `5`, blur. Expect the existing toast/feedback (if
  any) and the value to persist on reload.
- Keep for (days): enter `7`, blur. Same.
- Clear cache: click the button, confirm. Expect the existing
  success/error feedback and the cached content for that feed to
  be removed.

## Verify no carry-over across feed switches (Edge Case)

1. Select feed A. Open the cache panel.
2. From the sidebar, select feed B (without closing the panel
   first).
3. The panel for feed B MUST render in the closed state. Its inner
   controls MUST reflect feed B's policy (not A's).

## Verify narrow-viewport behavior (FR-008)

Resize the viewport down to roughly 700-800px (above the existing
mobile hamburger breakpoint). The summary MUST NOT visually
overlap the feed title above it or the "Unread only" / "Mark all
read" controls to its right. Open the panel; the same MUST hold
while open.

## Verify accessibility tree (FR-007)

In Chromium DevTools -> Accessibility panel (or Firefox A11y
inspector):

- Select the `<summary>` element.
- The accessible name MUST start with `Cache:` (the visible label
  is its accessible name; the `expand`/`collapse` hint is appended
  automatically by the component).
- The expanded/collapsed state MUST flip with each activation
  (`aria-expanded` is implied by `<details>` semantics in modern
  browsers; the toggle-label text serves as a redundant hint for
  older AT).

## Done conditions

- [ ] `npm test` and `npm run lint` are green.
- [ ] The route renders `<details-summary>` wrapping
      `<details><summary>...</summary><div class="details-content">
      ...</div></details>`.
- [ ] Mouse, touch, and keyboard all toggle the panel; visible
      focus is present at every step.
- [ ] Animation plays smoothly without reduced motion; with
      reduced motion the state still toggles but no motion is
      visible.
- [ ] Summary label updates immediately on cache-mode change and
      shows `(default)` only when the value comes from the user
      default.
- [ ] Clear cache, max size, max age, and cache mode all persist
      and feed back exactly as they did before this feature.
- [ ] Switching feeds with the panel open lands on the new feed
      with the panel closed and the new feed's values pre-filled.
- [ ] Narrow viewport (~700px) has no overlap with feed title or
      items-header controls.
