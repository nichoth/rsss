# Implementation Plan: Remove Redundant Sync Button from Settings

**Branch**: `013-remove-sync-button` | **Date**: 2026-05-08 |
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification from
`/specs/013-remove-sync-button/spec.md`

## Summary

Delete the user-facing "Sync" button (and its "Pull updates from the
server" caption + sync-error banner) from the Local Storage section
of `/settings`. This is a strictly UI removal: no schema, no API, no
sync-protocol changes. Background pull-then-push still runs through
`State.sync()` on startup and on the `online` event, and the home
route's "Refresh feeds" remains the canonical user-triggered way to
pull updates from the server.

Concretely, in `src/client/routes/settings.ts` we remove:

- the `<div class="sync-local-data">…</div>` block (lines 539-558,
  including the `${syncError.value && …}` banner immediately under
  it),
- the `handleSync` function (lines 376-386),
- the `runSyncCycle` import from `../db/sync-cycle.js`, and
- the `syncStatus, syncError` import from `../db/sync-status.js`
  (they are not referenced elsewhere in this file once the button
  goes).

In `src/client/routes/settings.css` we delete the now-unused
`.sync-local-data`, `.sync-local-data .sync-desc`, and `.btn-sync`
rules. No other CSS is touched.

The sync-cycle module itself, `sync-status.ts`, and the global
`<sync-status>` component stay; they are still consumed by automatic
background sync and by the global status indicator (out of scope per
FR-003).

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for
the Preact client; lines ≤ 80 cols; `?:type` colon style; ternaries
break per branch)
**Primary Dependencies**: Preact + `@preact/signals`, `htm/preact`,
`@substrate-system/check-box`, `@substrate-system/radio-input`
**Storage**: N/A. Client-side render-time state only. No SQLite
schema, sync payload, or persisted setting changes.
**Testing**: `npm test` (existing tap-style test runner) + `npm run
lint`. Manual browser verification of `/settings` and the home
route's "Refresh feeds" action per the constitution's "Local
verification" gate.
**Target Platform**: Same browsers RSSS already supports; no new
browser capability is required or removed.
**Project Type**: Web application (Cloudflare Worker backend +
Preact SPA frontend). Only the frontend SPA is touched.
**Performance Goals**: Settings page first paint and toggle
interaction unchanged. No new layout cost; deletion only.
**Constraints**: UI-only diff. Must not modify CSS unrelated to the
deleted button. Must not introduce new errors/warnings in the
browser console (FR-007). Must not regress neighbouring controls
(toggles, Cache, Subscription, home-route refresh).
**Scale/Scope**: One TS file, one CSS file, one route. Approx.
~25-30 lines of TS removed plus ~30 lines of CSS removed. No tests
need to change because no existing test asserts on the button (see
research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0,
principles I-V.

- **I. Local-First Reads** — PASS. Read paths and `localAdapter`
  are not touched. No new remote read is introduced; in fact the
  removed button was an explicit user-triggered fallback to
  `runSyncCycle`, and that machinery still runs automatically on
  startup / `online`.
- **II. Idempotent, Outbox-Backed Sync** — PASS. The outbox,
  `pushSync`, and the `/api/sync?since=…` pull contract are
  unchanged. `State.sync()` continues to drive pull-then-push
  automatically (per `state.ts` startup + `online` listener at
  line 467). Removing one of several entry points does not change
  idempotency semantics.
- **III. Edge-Native Topology (Worker + Per-User DO)** — PASS.
  Server, DO, alarms untouched.
- **IV. Capability-Gated Progressive Enhancement** — PASS.
  `getAdapter()` and the entitled / supported / tab-lock gates are
  unchanged. Removing a button rendered behind those gates only
  shrinks the gated UI; the gating logic itself is preserved.
- **V. Bluesky-Anchored Identity** — PASS. Auth / session / cookie
  story untouched.

**Coding-standards gates** (from constitution §"Technology Stack &
Coding Standards"):

- 80-column cap, `?:type` style, ternary-per-line: respected in the
  edited regions.
- CSS variables / nested selectors: only deleting rules; no new
  classes, no color literals introduced.
- "CSS unrelated to the current task MUST NOT be modified": only
  the three rules tied to the deleted button are removed; the
  `.bootstrap-error` rule reused by the now-removed
  `${syncError.value && …}` banner is shared with bootstrap and
  bootstrap-DB error rendering, so it stays.

**Workflow gates:**

- *Schema/sync coupling rule* — N/A; no schema or sync payload
  change.
- *Idempotency review for new mutation routes* — N/A; no new
  mutation route.
- *Capability fallback review* — N/A; no new read/write path.
- *Local verification* — explicit step in `quickstart.md`.

No violations; Complexity Tracking section is intentionally empty.

## Project Structure

### Documentation (this feature)

```text
specs/013-remove-sync-button/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (N/A entity-wise)
├── quickstart.md        # Phase 1 output (manual verification)
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

No `contracts/` directory: this feature exposes no external
interface, adds no API endpoint, and changes no payload schema.
Per the plan template guidance ("Skip if project is purely
internal"), the directory is intentionally omitted.

### Source Code (repository root)

Project layout matches the existing RSSS web-app structure (Worker
backend + Preact SPA frontend). The change is limited to the
frontend.

```text
src/
├── client/
│   ├── routes/
│   │   ├── settings.ts        # MODIFIED: remove handleSync, sync block, imports
│   │   └── settings.css       # MODIFIED: remove .sync-local-data + .btn-sync rules
│   ├── db/
│   │   ├── sync-cycle.ts      # UNCHANGED (still used by State.sync)
│   │   └── sync-status.ts     # UNCHANGED (still drives global status pill)
│   └── components/
│       └── sync-status.ts     # UNCHANGED (global indicator, out of scope)
├── server/                    # UNCHANGED
└── shared/                    # UNCHANGED

test/
├── settings-route.ts          # UNCHANGED (does not assert on the Sync button)
└── local-first-settings.ts    # UNCHANGED
```

**Structure Decision**: Web application layout (`src/client` +
`src/server` + `src/shared` + `test/`). The diff is confined to
two files under `src/client/routes/`. No new files are created in
this feature's source tree; only `specs/013-remove-sync-button/`
documentation files are added.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

No violations. Section intentionally empty.
