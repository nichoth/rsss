# Implementation Plan: Cache Settings Disclosure (Feed Reader)

**Branch**: `007-cache-settings-disclosure` | **Date**: 2026-05-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-cache-settings-disclosure/spec.md`

## Summary

Replace the bare `<details><summary>Cache: ...</summary>...</details>`
in `src/client/routes/feed-reader.ts` with the
`@substrate-system/details-summary` web component. The web component
gives the summary a visible affordance (built-in animated `+` / `x`
icon, accessible "expand"/"collapse" hint, hover/focus styles, smooth
JS-driven open/close). The change is presentational and route-scoped:
no schema, no sync, no server changes; the inner cache mode select,
max-size, max-age inputs, and clear-cache button remain wired to the
same `upsertFeedCachePolicy` / `clearFeedCache` flows.

The feed-reader route key on `selectedFeed.id` is reused so switching
feeds remounts the disclosure (Edge Case "no carry-over"). A
`prefers-reduced-motion: reduce` media query collapses the component's
`duration` attribute to `0` so the open/close state still toggles but
without motion.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite)  
**Primary Dependencies**: Preact, `@preact/signals`, `htm/preact`,
`@substrate-system/details-summary` (already in `package.json` at
`^0.0.2`)  
**Storage**: N/A (UI-only; reuses existing per-feed cache policy
table; no schema change)  
**Testing**: existing `npm test` (tapout/tapzero suites under
`test/`) + manual browser check per constitution "Local
verification" gate  
**Target Platform**: Modern evergreen browsers (Element.animate /
WAAPI required for the disclosure animation; matches the rest of the
client)  
**Project Type**: Single-page web client inside `src/client/`  
**Performance Goals**: No perceptible regression; open/close
animation under ~300 ms (FR-003, SC-004)  
**Constraints**: 80-col TS lines; no-space-after-colon typing; reuse
`_variables.css` tokens; `font-size >= 1rem`; do not modify CSS
unrelated to this feature; no service worker changes; no PII /
session token logging  
**Scale/Scope**: One route, one CSS block, plus a global stylesheet
import for the component. No API surface, no new dependency.

## Constitution Check

Evaluated against RSSS Constitution v1.0.0.

| Principle | Relevance | Notes |
|-----------|-----------|-------|
| I. Local-First Reads | N/A | No new read. The cache policy already loads via `loadFeedPolicies()` (local-first today); this feature only changes the disclosure widget that wraps the existing form. |
| II. Idempotent, Outbox-Backed Sync | N/A | No new mutation. The existing `upsertFeedCachePolicy` and `clearFeedCache` paths inside the panel are untouched. |
| III. Edge-Native Topology | N/A | No worker, DO, alarm, or parser change. |
| IV. Capability-Gated Progressive Enhancement | PASS | Disclosure renders identically regardless of which adapter populated `feedPolicies`. The web component falls back to a plain `<details>` styling if its JS fails to upgrade (`details-summary:not(:defined) { display: none }` is overridden with a CSS rule documented in research R3 so the native `<details>` still works pre-upgrade — this preserves the existing baseline behavior). |
| V. Bluesky-Anchored Identity | N/A | No auth changes. |

**Coding-standards gates** (per Tech Stack & Coding Standards):

- 80-col TS lines, no-space-after-colon typing. The existing
  feed-reader route already follows this; the new htm template will
  too.
- `batch()` for sequential signal writes: this feature does not write
  signals.
- CSS rules: reuse `_variables.css` tokens (`--color-text`,
  `--color-text-secondary`, `--color-border`); do not touch unrelated
  CSS; `font-size >= 1rem` on the summary and inner controls.
- No emoji in code or filenames.
- No PII / token logging (no logging added at all).

**Result**: Initial gate **passes** with no violations.

**Post-design re-check** (after `data-model.md`, `quickstart.md`,
and the markup contract were drafted): no new constitutional
concerns introduced. The data model adds no entity, the markup
contract adds no API surface, and reduced-motion handling lives in
the route's local `useEffect` rather than `state.ts` (preserving
Principle II's "no new outbox bypass" by not introducing any new
mutation path). Gate still **passes**.

## Project Structure

### Documentation (this feature)

```text
specs/007-cache-settings-disclosure/
|-- plan.md          # This file
|-- spec.md          # Feature spec (already written)
|-- research.md      # Phase 0 output
|-- data-model.md    # Phase 1 output
|-- quickstart.md    # Phase 1 output
`-- tasks.md         # Phase 2 output (created later by /speckit.tasks)
```

No `contracts/` directory: this feature does not change any external
interface (no HTTP route, no DO method, no CLI). The "contract" is
the markup shape the `<details-summary>` web component expects, which
is documented in the data model and exercised in the quickstart.

### Source Code (repository root)

```text
src/
|-- client/
|   |-- routes/
|   |   |-- feed-reader.ts    # MODIFIED: wrap details in <details-summary>
|   |   `-- feed-reader.css   # MODIFIED: scope + tune component CSS vars
|   |-- index.ts              # MODIFIED: side-effect import of the component
|   |-- style.css             # MODIFIED: @import the component's stylesheet
|   `-- ...                   # unchanged
|-- server/                   # unchanged
|-- shared/                   # unchanged
`-- sw/                       # unchanged

test/
|-- feed-reader-cache-disclosure.ts   # NEW: DOM/markup test
`-- ...                                # unchanged
```

**Structure Decision**: Single-project layout under `src/`. The
change is localized to `src/client/routes/feed-reader.ts` and its
sibling `feed-reader.css`. Two side-effect import lines are added
(one JS, one CSS) so the custom element is registered and styled
exactly once for the whole app. Persistence (`feed-cache-policy.ts`)
and the underlying `feedPolicies` signal are not touched.

## Complexity Tracking

> No constitutional violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | -          | -                                   |
