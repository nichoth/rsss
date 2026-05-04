# Phase 0 Research: Cache Settings Disclosure (Feed Reader)

The spec has no `[NEEDS CLARIFICATION]` markers. The dependency
(`@substrate-system/details-summary`) is already in `package.json`
and the data path (per-feed cache policy) is already in the project.
This document records the design choices that the implementation
tasks will be derived from.

## R1. Where the disclosure lives

**Decision**: Modify `src/client/routes/feed-reader.ts` only.

**Rationale**:

- The user's request and spec are explicit that this change is
  scoped to the feed reader route. The visually similar cache form
  inside the `Settings` route (`src/client/routes/settings.ts`) is
  out of scope per the spec's Assumptions.
- The current disclosure is implemented inline in
  `feed-reader.ts:228-333` as a vanilla `<details>` with a `<summary>`
  containing the "Cache: ..." label. We replace that subtree;
  nothing else moves.
- Keeping the markup inline (rather than introducing a new Preact
  component) is consistent with the existing route file: the same
  IIFE block is already used for the cache controls, and pulling
  this one subtree into a separate component would generate diff
  noise without saving repetition.

**Alternatives considered**:

- New `<FeedCacheDisclosure/>` Preact component: rejected. There is
  exactly one call site, so a component would just shuffle code
  around without simplifying it. Reconsider when the same disclosure
  is needed in the Settings route (out of scope here).
- Replace the underlying `<details>` with a custom-built Preact
  disclosure: rejected. The whole point of this feature is to use
  `@substrate-system/details-summary`, which already ships the
  affordance, animation, accessible toggle label, and
  open/close events.

## R2. Markup shape required by the component

**Decision**: Wrap the existing `<details><summary>...</summary>
{form}{button}</details>` with `<details-summary>` and put all
non-summary content into a single `<div class="details-content">`.

The component (`node_modules/@substrate-system/details-summary/dist/
index.js`) does the following at upgrade time:

1. Queries its child `<details>`, `<summary>`, and
   `.details-content`.
2. Appends a `<span class="details-summary-icon"
   aria-hidden="true">` and a `<span class="visually-hidden">expand|
   collapse</span>` into the existing `<summary>`.
3. Intercepts `summary` clicks, calls `Element.animate({ height: ...
   })` for the open/close transition, and dispatches `open` /
   `close` events.

So the contract is:

```html
<details-summary>
    <details>
        <summary>{label}</summary>
        <div class="details-content">
            {everything else}
        </div>
    </details>
</details-summary>
```

**Implication for the existing markup**: the `<button class=
"btn-clear-cache">` that today sits as a sibling of `<div class=
"feed-cache-form">` (both children of `<details>`) must move
**inside** the new `<div class="details-content">`. Otherwise the
component will not include the button in its measured open height,
and the animation will clip it.

**Rationale**: This is the published API of the component. Changing
the markup shape on our side keeps us on the supported path.

**Alternatives considered**:

- Two `.details-content` blocks: rejected. The component selects
  with `querySelector('.details-content')` (singular), so a second
  block would be ignored by the height measurement.
- Re-using the existing `.feed-cache-form` class as the content
  wrapper: rejected. The component requires the literal class name
  `details-content`. We can keep `.feed-cache-form` as an inner
  child to preserve the existing CSS rule that styles the
  flex-column form layout.

## R3. CSS theming and overrides

**Decision**: Override the component's CSS variables inside the
existing `.feed-cache-controls` selector in
`src/client/routes/feed-reader.css`. Specifically:

```css
.feed-cache-controls {
    --details-summary-padding: 0;
    --details-summary-font-weight: 400;
    --details-summary-font-size: 1rem;
    --details-summary-content-color: var(--color-text);
    --details-summary-transition-speed: 0.2s;
    /* The component's bottom-border conflicts with the items-header
       border; opt out by setting the alpha to 0 via the RGB var. */
    --details-summary-border-color: 0, 0, 0; /* keeps inherited rgb */
    border-bottom: none; /* component's outer rule is `1px solid
                            rgb(var(--details-summary-border-color),
                            .1)` -- override the resulting border
                            on the host instead. */
}
```

The summary already gets `cursor: pointer` from the component's
stylesheet; we keep `color: var(--color-text-secondary)` and
`user-select: none` from today.

**Stylesheet wiring**: add
`@import url("@substrate-system/details-summary/css")` to
`src/client/style.css` next to the other component CSS imports
(check-box, tool-tip, hamburger-two). The package's
`exports./css` entry resolves to `dist/index.css`.

**Rationale**:

- The component's defaults (`16px` font, `1rem` padding, `600`
  weight, `#444` content color, bottom border) belong on a card or
  a long-form FAQ section, not on a tight inline control between a
  feed title and the items-header buttons. Overriding via the
  documented CSS variables keeps us on the supported path while
  matching the surrounding theme.
- All the colors used route through tokens already defined in
  `_variables.css` (`--color-text`, `--color-text-secondary`,
  `--color-border`). No new tokens introduced. Per project rules
  ("CSS unrelated to the current task MUST NOT be modified") the
  global `_variables.css` is left untouched.

**Alternatives considered**:

- Skip the variable overrides and accept the default look:
  rejected. The defaults add a 1rem padded box with a thick weight,
  which collides with the items-header layout (FR-008) and
  contradicts the spec's "follow the project's existing CSS
  variables and the disclosure component's default look,
  customised only as needed" assumption.
- Local CSS file (`feed-cache-disclosure.css`) imported only by
  `feed-reader.ts`: rejected. Vite imports CSS once globally
  anyway, and a third file just adds an indirection. The existing
  `feed-reader.css` is the right home.

## R4. Reduced-motion handling

**Decision**: Toggle the component's `duration` attribute based on
`window.matchMedia('(prefers-reduced-motion: reduce)')`. When the
media query matches, set `duration="0"`; otherwise omit the
attribute (component default is 300ms).

Mechanism: a `useEffect` hook in `FeedReader` subscribes to the
media query change event and stores the boolean in a small local
signal/state. The htm template reads it and either passes
`duration="0"` or no `duration` attribute. (Setting `duration="0"`
is safe per the component's `_animationDuration()` which accepts
`>= 0`.)

**Rationale**:

- The component does not honor `prefers-reduced-motion` itself --
  it calls `Element.animate` directly with the configured duration.
  Without an explicit override, motion-sensitive users would still
  see the height/opacity tween (FR-003 violation, edge case
  "Users with `prefers-reduced-motion`").
- Using the existing attribute keeps the open/close *state*
  transition immediate and observable to assistive tech (the
  `<details>` element still flips `open` and the icon still rotates
  via the component's CSS class swap), only the motion itself is
  removed.

**Alternatives considered**:

- Force `duration="0"` always: rejected. Loses SC-004's "feels
  smooth" benefit for the majority who do not prefer reduced
  motion.
- Use only `@media (prefers-reduced-motion: reduce)` CSS to disable
  the existing CSS transitions: insufficient. The component's
  height tween is a JS WAAPI call, not a CSS transition. CSS alone
  cannot stop it.
- Use the `motion-safe` / `motion-reduce` Tailwind-style hooks:
  rejected. The project does not use Tailwind and the
  `matchMedia`-driven attribute is a one-line idiom that fits the
  existing `useEffect` patterns in the file.

## R5. State carry-over when feeds switch

**Decision**: Pass a `key={selectedFeed.id}` to the
`<details-summary>` element so Preact remounts the disclosure when
the user picks a different feed.

**Rationale**:

- Edge case: "When a feed is deselected or switched, an open
  disclosure should not 'carry over' stale state into the newly
  selected feed."
- The current IIFE inside `feed-reader.ts:228-333` already
  re-renders the inner controls when `selectedFeed.id` changes, but
  the `<details>` element is the same DOM node, so its `open`
  attribute and the component's internal `_isClosing/_isExpanding`
  flags persist across feed switches. A key remounts both, which
  starts each feed in the closed state without us writing
  imperative cleanup code.

**Alternatives considered**:

- Listen for `feedUrl` changes in a `useEffect` and call
  `details.removeAttribute('open')`: rejected. Imperative DOM
  pokes against a wrapping web component invite race conditions
  with the in-flight WAAPI animation. A key-driven remount is
  declarative and well-understood by Preact.

## R6. Tests

**Decision**: Add one new test file
`test/feed-reader-cache-disclosure.ts` (registered in
`test/index.ts` next to the other client tests) covering:

1. The route renders a `<details-summary>` element wrapping a
   `<details>` with a `<summary>` whose text starts with `Cache:`.
2. The inner `<div class="details-content">` exists and contains
   the cache-mode `<select>`, the max-size `<input>`, the max-age
   `<input>`, and the `.btn-clear-cache` button.
3. Switching `selectedFeed` (by changing the route) remounts the
   disclosure (assert the `<details>.open` attribute is absent for
   the new feed even after we open it on the previous feed in the
   same test run).

The component's animation, focus, and ARIA wiring are already
covered by `@substrate-system/details-summary`'s own test suite
upstream; we do not retest those.

A manual browser check is required by the constitution's "Local
verification" gate. See `quickstart.md` for the recipe.

**Rationale**:

- Asserting the markup shape is the cheap automated equivalent of
  the spec's User Story 1: it locks in that the route renders a
  control that *is* a disclosure rather than plain text. The
  component's class-name contract (`details-content`,
  `details-summary-icon`) is what makes the affordance work, so the
  tests target those.
- Behavior tests (animation/click/keyboard) inside JSDOM are
  brittle (no real WAAPI, no layout) and would re-test the
  upstream package. The constitution's "Local verification" gate
  in a real browser is the right place for that.

**Alternatives considered**:

- Full Playwright integration test for the open/close interaction:
  deferred. The project does not use Playwright today; introducing
  it for one feature is outside scope. If we add Playwright later
  for unrelated reasons, this test should be migrated.
- Snapshot test of the rendered markup: rejected. Snapshots over
  the entire route would break on every unrelated tweak; a
  targeted querySelector test is more durable.

## R7. Icon affordance verification

**Decision**: Rely on the component's built-in
`<span class="details-summary-icon" aria-hidden="true">` plus the
`expand` / `collapse` visually hidden label. The icon rotates 45
degrees on `[open]:not(.is-closing)` per the component's CSS,
producing the documented `+` -> `x` (chevron equivalent) transition
named in spec FR-001.

**Rationale**: The spec asks for "an explicit indicator such as a
chevron/caret"; the `+/x` rendering satisfies that. The component
also exposes the affordance to AT users via the visually-hidden
label and via the native `<details>` element's role / expanded
state, so SC-003 (keyboard end-to-end with visible focus) and
FR-007 (AT exposure) are met without extra wiring on our side.

**Alternatives considered**:

- Replace the icon with a custom chevron SVG: rejected. The
  component's icon is already styled with `currentColor`, so it
  inherits whatever color we set; no need for a fork.
