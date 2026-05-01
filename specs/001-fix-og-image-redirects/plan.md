# Implementation Plan: Fix "Redirected Too Many Times" Errors During Feed Refresh

**Branch**: `001-fix-og-image-redirects` | **Date**: 2026-04-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-fix-og-image-redirects/spec.md`

## Summary

The "refresh feeds" action emits `console.error('Error fetching og image …:
FeedFetchError: Feed redirected too many times')` whenever an article URL
follows more than 3 redirects. Root cause: feed-XML fetches and article-page
fetches (for OpenGraph thumbnail enrichment) share a single
`fetchValidatedResponse` helper with a hardcoded `MAX_FEED_REDIRECTS = 3`,
and the Durable Object logs every OG-enrichment failure at error level.

The fix decouples the two redirect budgets (article fetches get 5 hops;
feed-XML keeps 3), routes the article path through a clearly-labelled error
so a stray future log call cannot mislabel it as a feed failure, and stops
treating routine OG-enrichment failures as `console.error`. Feed-XML
failures continue to be recorded against the feed row (`last_error`,
`last_status`) and logged once, per FR-005. No schema, sync, or client
changes.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers runtime, ES2022 lib)
**Primary Dependencies**: `hono`, `@cloudflare/workers-types`, `fast-xml-parser`
(server only); no client deps touched.
**Storage**: Per-user Durable Object SQLite. No schema or sync changes.
**Testing**: `tap`/`tapout` (existing pattern in `test/feed-fetch-security.ts`
and `test/feed-parser.ts`); ad-hoc `console.error` spy for log-quietness
assertions.
**Target Platform**: Cloudflare Workers + Durable Objects (server-side
behaviour change only).
**Project Type**: Edge web service (Worker + per-user Durable Object) with a
Preact SPA. Change is server-only.
**Performance Goals**: A "refresh feeds" run with a single article URL in a
genuine redirect loop completes within roughly the same wall time as the
same refresh without that item — already enforced by the existing
`OG_IMAGE_FETCH_BUDGET_MS = 10_000` deadline; no change needed.
**Constraints**: Must not change `/api/refresh` response shape; must not
introduce log lines that contain PII; must not modify CSS or unrelated code.
**Scale/Scope**: Two source files (`src/server/feed-fetch.ts`,
`src/server/durable-objects/index.ts`) plus tests in `test/`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against `/Users/nick/code/rsss/.specify/memory/constitution.md`
v1.0.0:

- **I. Local-First Reads** — N/A. Server-only change. No new client read,
  no `localAdapter` schema impact.
- **II. Idempotent, Outbox-Backed Sync** — N/A. No mutations introduced or
  modified. The refresh path already returns idempotent feed/item writes.
- **III. Edge-Native Topology** — Compatible. All work stays inside the
  per-user `UserDO`. No new cross-user state, no external queues, no new
  alarms or workers.
- **IV. Capability-Gated Progressive Enhancement** — N/A. No new client
  read or write path; both `localAdapter` and `remoteAdapter` are unaffected
  because the `/api/refresh` contract does not change.
- **V. Bluesky-Anchored Identity** — N/A. No auth changes.

Coding-standards gate:

- TypeScript style (80-col, no space after colon, multi-line ternaries) is
  preserved.
- No CSS changes (rule: "do not change CSS that is not related to the
  task").
- No emoji in code/comments.
- Logging & privacy: change *reduces* logging. Article URLs are already
  user-visible item links, but we still avoid logging them at error level
  per FR-003/FR-004.

**Result**: PASS. No Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-fix-og-image-redirects/
├── plan.md              # This file (/speckit.plan output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (declares "no schema change")
├── quickstart.md        # Phase 1 output (verification recipe)
├── contracts/
│   └── README.md        # Phase 1 output (no external contract changes)
└── tasks.md             # Phase 2 output (/speckit.tasks - not in this run)
```

### Source Code (repository root)

```text
src/
├── server/
│   ├── feed-fetch.ts                # Decouple redirect budgets;
│   │                                #   feed XML keeps 3, article gets 5
│   └── durable-objects/
│       └── index.ts                 # Stop console.error for OG-enrichment
│                                    #   failures; keep feed-XML logging
│
test/
├── feed-fetch-security.ts           # Update redirect-limit test (now 6
│                                    #   calls, not 4); add a feed-XML
│                                    #   redirect-limit test
└── feed-parser.ts                   # Add: refresh stays quiet when an
                                     #   article URL exceeds its budget
```

**Structure Decision**: Single web project, Worker + DO topology already in
place. The change touches two existing server files and two existing test
files. No new modules, no new directories, no client-side code.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None. Constitution Check passed without violations.
