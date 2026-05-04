# Implementation Plan: Sync Status Legend

**Branch**: `006-sync-status-legend` | **Date**: 2026-05-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-sync-status-legend/spec.md`

## Summary

Add a short text label next to the existing colored sync indicator in
the top-right of the header so its meaning is self-evident:

- green dot -> "up to date"
- blue dot  -> "1 update" / "n updates"
- yellow dot -> "refreshing"

Implementation is confined to the existing `FeedStatus` Preact
component (`src/client/components/feed-status.ts` and its CSS). Both
the visible label and the `aria-label` come from a single per-state
mapping so sighted and AT users see the same wording. The gray
(`inactive`) and red (`error`) states are out of scope and their
current presentation is preserved unchanged. No new state, no new
data source, no schema, sync, or server changes.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite)  
**Primary Dependencies**: Preact, `@preact/signals`, `htm/preact`  
**Storage**: N/A (pure UI; consumes existing client signals)  
**Testing**: existing `npm test` (unit/integration) + manual browser
check per constitution "Local verification" gate  
**Target Platform**: Modern evergreen browsers; same matrix as the
rest of the client  
**Project Type**: Single-page web client inside `src/client/`  
**Performance Goals**: No perceptible regression; signal-driven
re-render only when `feedSyncStatus` or `feedUpdateCounts` change
(unchanged from today)  
**Constraints**: Follow project CSS rules (`>= 1rem` font sizes; reuse
existing CSS variables; no edits to unrelated CSS); 80-col TS lines;
no service worker changes  
**Scale/Scope**: One component, three label strings, plus responsive
CSS for narrow viewports; no API surface

## Constitution Check

Evaluated against RSSS Constitution v1.0.0.

| Principle | Relevance | Notes |
|-----------|-----------|-------|
| I. Local-First Reads | N/A | No new read; consumes existing in-memory signals (`feedSyncStatus`, `feedUpdateCounts`) that are already populated by the local-first / fallback adapters. |
| II. Idempotent, Outbox-Backed Sync | N/A | No mutations introduced. |
| III. Edge-Native Topology | N/A | No server, DO, or alarm changes. |
| IV. Capability-Gated Progressive Enhancement | PASS | UI label is rendered identically regardless of which adapter populated the signals; no capability gating involved. The whole indicator already short-circuits when `state.user.value` is null. |
| V. Bluesky-Anchored Identity | N/A | No auth changes. |

**Coding-standards gates** (per Tech Stack & Coding Standards):

- 80-col TS lines, no-space-after-colon typing, `batch()` for any
  sequential signal writes (this feature does not write signals, so
  `batch()` is moot, but we will keep this rule top of mind if any
  helper grows during review).
- CSS: reuse `_variables.css` tokens; do not touch unrelated CSS;
  `font-size >= 1rem`. The new label inherits the existing
  `.feed-status` font-size (1rem) and color tokens.
- No emoji in code or filenames.
- No PII / token logging (no logging added at all).

**Result**: Initial gate **passes** with no violations. Re-check after
Phase 1 design.

## Project Structure

### Documentation (this feature)

```text
specs/006-sync-status-legend/
|-- plan.md          # This file
|-- spec.md          # Feature spec (already written)
|-- research.md      # Phase 0 output
|-- data-model.md    # Phase 1 output
|-- quickstart.md    # Phase 1 output
|-- checklists/
|   `-- requirements.md
`-- tasks.md         # Created later by /speckit.tasks
```

No `contracts/` directory: this feature does not change any external
interface (no HTTP route, no DO method, no CLI). The "contract" is
the per-state label mapping, which lives in the component and is
covered by the data model + quickstart.

### Source Code (repository root)

```text
src/
|-- client/
|   |-- components/
|   |   |-- feed-status.ts        # MODIFIED: per-state label + aria
|   |   |-- feed-status.css       # MODIFIED: spacing + narrow-viewport rule
|   |   |-- dot.ts                # unchanged (already maps colors)
|   |   `-- header.ts             # unchanged (already mounts <FeedStatus/>)
|   `-- state.ts                  # unchanged (signals already exist)
|-- server/                       # unchanged
|-- shared/                       # unchanged
`-- sw/                           # unchanged
```

**Structure Decision**: Single-project layout under `src/`. The change
is localized to two files in `src/client/components/` (`feed-status.ts`
and `feed-status.css`). The header host
(`src/client/components/header.ts`) and the `Dot` primitive
(`src/client/components/dot.ts`) require no modification. State
plumbing (`feedSyncStatus`, `feedUpdateCounts`) already exists in
`src/client/state.ts` and continues to be the single source of truth.

## Complexity Tracking

> No constitutional violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | -          | -                                   |
