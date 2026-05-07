# Implementation Plan: Background Feed Polling for Accurate Status Indicator

**Branch**: `009-background-feed-polling` | **Date**: 2026-05-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/009-background-feed-polling/spec.md`

## Summary

Feature 008 fixed *how* the "n updates / up to date" pill is computed
and transmitted, but the indicator's truthfulness depends on the
server having an up-to-date view of each subscribed feed. Today the
only thing that brings new items into the per-user store is a manual
"Refresh Feeds" click. Between refreshes the server has no way to
discover that a feed has published, so
`items.pub_date > feeds.last_pulled_at` returns zero and the
indicator stays green — exactly the bug the user is reporting.

This feature wires the missing piece: the server polls subscribed
feeds in the background so the indicator reflects reality without
requiring a manual refresh.

The implementation reuses the DO alarm path that already exists
(10-minute cadence, see `src/server/durable-objects/index.ts`
constructor + `alarm()`), and layers four narrow additions on top:

1. **Per-feed conditional GETs and 304 handling** — extend
   `fetchFeedText` with `If-None-Match` / `If-Modified-Since` and a
   `notModified` return field; skip parse/ingest on 304 (FR-005,
   SC-003).
2. **Per-feed exponential backoff** — track `consecutive_failures`
   and `next_due_at` per feed; the alarm sweep skips feeds that are
   not yet due (FR-007).
3. **Per-account inactivity gate** — track `last_active_at` per user;
   the alarm sweep returns early for accounts inactive past the
   threshold (FR-008, SC-005).
4. **Page-load catch-up** — `/feed-status` schedules a non-blocking
   sweep via `ctx.waitUntil` when the account has been paused or no
   feed has been polled successfully within the last cadence
   (returning-after-days edge case).

All new bookkeeping lives in per-user **DO storage** (KV-style
`ctx.storage.put`), not in the SQLite `feeds` table — so this
feature ships without a schema migration, without `/api/sync` payload
changes, and without any client mirror updates. The
`/feed-status` HTTP contract and the `feed-updates-available` SSE
event from feature 008 are preserved verbatim.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers runtime, ES2022
lib for server / DO; ES2022 via Vite for client)
**Primary Dependencies**: Hono (server router),
`@cloudflare/workers-types`, `fast-xml-parser` (existing feed
parser, unchanged), Preact + `@preact/signals` + `htm/preact`
(client; receives via existing SSE channel — no new code path)
**Storage**: Per-user Durable Object SQLite (existing `feeds`,
`items` tables, no new columns); Durable Object KV-style storage
(`ctx.storage.put` / `ctx.storage.get`) for new poller state under
`poll:feed:<id>`, `poll:account:last_active_at`,
`poll:account:last_any_success_at`
**Testing**: `tape` test files under `test/` (Node-side stubs of CF
Workers + DOM); browser-driven runs through `npm test`
**Target Platform**: Cloudflare Workers (DO + Worker), modern
evergreen browsers for the client
**Project Type**: Web application (Cloudflare Worker + Preact SPA in
the same repo; `src/server`, `src/client`, `src/shared`)
**Performance Goals**: SC-001 — correct counts on returning page
load in ≥95% of sessions, within 2 s; SC-002 — live transition
within `cadence + 5 s` while open; SC-003 — ≥80% conditional-GET hit
rate on stable feeds across a week; SC-004 — full sweep of 500
feeds within base cadence with ≤1 origin request per feed per
cadence; SC-005 — zero polling activity for accounts past the
inactivity threshold; SC-006 — spurious "up to date" page loads
effectively zero
**Constraints**: No SQLite schema migration; no `/api/sync` payload
change; no client mirror change; no new auth surface; the existing
`/feed-status` HTTP and SSE contracts from feature 008 MUST remain
identical from the client's point of view; no per-feed request
fan-out from the client (server stays the only thing talking to feed
origins, per spec assumption)
**Scale/Scope**: Per-user up to 500 subscribed feeds (SC-004);
per-user DO continues to own all that user's polling state. Account
fleet scale is bounded by the alarm-tick cost at 10-minute cadence
times the active-user count; inactivity gating (FR-008) handles the
long tail of dormant accounts.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0
(principles I-V):

- **I. Local-First Reads** — PASS. The indicator is meta-state about
  server-vs-client divergence; the local mirror cannot derive it
  alone. The client read path (`loadFeedStatus`) is unchanged from
  feature 008. Background polling is server-internal data freshness
  for the *server side* of that comparison; it does not introduce
  any client-side network read for happy-path data.
- **II. Idempotent, Outbox-Backed Sync** — PASS. No new client→
  server mutations and no outbox change. Server-side inserts use the
  existing `INSERT OR IGNORE INTO items` plus the existing
  `UNIQUE(feed_id, guid)` constraint, which is the correctness
  backstop for FR-011 ("scheduled poll overlapping with manual
  refresh cannot produce duplicates"). Schema-and-sync coupling rule
  is honored by *not adding* poller-internal columns to the synced
  `feeds` table — see `data-model.md` for the rationale.
- **III. Edge-Native Topology (Worker + Per-User DO)** — PASS. All
  polling logic lives inside `UserDO`. The DO alarm mechanism is the
  driver (existing 10-min cadence per the constitution); no external
  cron, queue, or worker is introduced. Per-feed and per-account
  poller state lives in the same per-user DO's storage — no cross-
  user shared state.
- **IV. Capability-Gated Progressive Enhancement** — PASS. This
  feature is server-side only. Both `localAdapter` and
  `remoteAdapter` benefit identically because the indicator path
  (`/feed-status` + SSE) is shared and unchanged.
- **V. Bluesky-Anchored Identity** — PASS. No auth changes. The
  alarm continues to fire under the existing user-identity binding;
  `last_active_at` is keyed off the existing per-user DO and writes
  no new credential, session, or identity material.

No violations; Complexity Tracking section unused.

## Project Structure

### Documentation (this feature)

```text
specs/009-background-feed-polling/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── polling-sweep.md
│   ├── conditional-fetch.md
│   └── page-load-catchup.md
└── tasks.md             # Phase 2 output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── server/
│   ├── durable-objects/
│   │   └── index.ts            # alarm + sweep updates: per-feed
│   │                           # nextDueAt filter; conditional GET
│   │                           # plumbing into fetchFeed; backoff;
│   │                           # last_active_at gate; /feed-status
│   │                           # catch-up trigger via waitUntil;
│   │                           # delete poll:feed:<id> on feed delete
│   ├── feed-fetch.ts           # fetchFeedText: optional validators
│   │                           # input; 304 short-circuit; etag /
│   │                           # last_modified extraction; result
│   │                           # gains notModified + new validators
│   └── (no other server files change)
├── shared/
│   └── (no changes — schema unchanged on purpose)
└── client/
    └── (no changes — /feed-status + SSE contract preserved)

test/
├── alarm.ts                    # extend: per-feed nextDueAt skip;
│                               # inactivity gate; cursor walk
│                               # filters out not-due feeds
├── feed-status.ts              # extend: returning-after-days
│                               # catch-up triggers waitUntil
├── do-handlers.ts              # extend: 304 path returns no items;
│                               # backoff increments / resets
├── feed-fetch-security.ts      # unchanged (still passes)
└── poll-state.ts               # NEW: PollerFeedState read/write
                                # contract + AccountActivityMarker
```

**Structure Decision**: This repo does not use the
`backend/`/`frontend/` split shown in the plan template; the actual
layout is `src/server`, `src/client`, `src/shared`. The plan
references real paths. All implementation work for this feature is
contained inside `src/server/durable-objects/index.ts` and
`src/server/feed-fetch.ts`; no client or shared file is modified.

## Complexity Tracking

> Not applicable. Constitution Check passes without violations.

## Post-Design Constitution Re-check

After Phase 1 (data-model, contracts, quickstart), the design holds
the same five principles:

- **I**: still no client read changes; happy-path reads still go
  through `localAdapter` unchanged.
- **II**: confirmed during data-model design — poller-internal state
  lives in DO KV storage *specifically* to avoid coupling a sync
  payload change to this feature; existing item-insert idempotency
  via `UNIQUE(feed_id, guid)` covers FR-011.
- **III**: alarm-driven; no new infra; per-user DO ownership of all
  poller state.
- **IV**: catch-up trigger lives behind `/feed-status`, which both
  adapters call identically.
- **V**: no auth surface change; `last_active_at` is a per-user DO
  KV record, not a session or identity token.

No design surprise pulled the feature into a constitutional gray
zone. Complexity Tracking remains empty.
