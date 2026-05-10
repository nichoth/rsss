# Implementation Plan: Fix Dev Server FOUC and Vite Dynamic-Import Warning

**Branch**: `016-fix-dev-server-fouc` | **Date**: 2026-05-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-fix-dev-server-fouc/spec.md`

## Summary

Two distinct dev-only regressions, with two distinct root causes that
happen to share an environment.

**Vite warning** (`src/server/index.ts:1493`):
`await import(blurhashRuntimeModule)` reads from a non-literal binding.
Vite's static analyzer cannot follow a variable to its declaration site
to identify the import target, so it warns and disables chunk
extraction for that import. Fix: write the path as a literal at the
import site — `await import('./blurhash-runtime.js')`. Lazy-load
semantics are preserved because Vite still creates a separate chunk
for any literal `import(...)` expression. Verified post-build by
inspecting `public/_worker.js/` for a separate `blurhash-runtime`
chunk.

**Dev FOUC + wrong-route flash**: feature 015 added
`<link rel="stylesheet" href="/src/client/style.css">` to
`index.html`, which makes the body, route, and feed-reader CSS
load synchronously in both dev and prod. That fixed the production
FOUC because Vite's prod build *also* extracts every JS-imported CSS
into the same `<link>` bundle. In dev, Vite does **not** do that
extraction — per-component CSS imports
(`src/client/components/header.ts:11` →
`import './header.css'`, plus item-row.css, sidebar.css, page-skeleton.css,
~15 more) become JS modules that inject `<style>` tags only after the
JS bundle evaluates. The lazy-HTML pipeline
(`src/server/lazy-html-handler.ts`) seeds rendered feed-item markup
into `#root` server-side; in dev that markup paints with only
`style.css` + its `@import` chain applied (covers `feed-reader.css`,
`_variables.css`, normalize, etc.) but **not** the per-component CSS
the seeded markup depends on. The window from first paint to JS
evaluation shows the seeded markup unstyled. Separately, the lazy-HTML
handler seeds feed content for every authenticated request without
checking the route — so a developer who is logged in and refreshes
`/login` sees article markup in `#root` while the URL bar reads
`/login`.

The chosen fix (see `research.md` Decision 2): in dev, skip the
lazy-HTML pipeline entirely and fall through to
`c.env.ASSETS.fetch(c.req.raw)`, which returns the unseeded shell.
The empty `<div id="root"></div>` paints first, the JS bundle loads
and evaluates, component CSS modules inject their `<style>` tags, and
the route renders styled — never unstyled, never wrong-route. In
production the request path is unchanged (lazy HTML still seeds, the
`<link>` from feature 015 still covers all CSS via Vite's prod CSS
extraction). Detection is via Vite's compile-time
`import.meta.env.DEV`, which `@cloudflare/vite-plugin` substitutes in
worker code at build time the same way it does in client code (used
today at `src/client/index.ts:30` and `src/client/routes/login.ts:68`).

The two fixes are independent. The dynamic-import fix is also a
prerequisite for any future build-graph analysis of the worker
bundle, but it does not by itself eliminate the FOUC.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for the
client; Cloudflare Workers ES2022 for the server worker — both touched).
**Primary Dependencies**: Vite 7 + `@cloudflare/vite-plugin` (build
pipeline), Hono (server), Preact + `@preact/signals` (rendering — not
modified). No new dependencies.
**Storage**: N/A. No SQLite schema change, no DO schema change, no
`/api/sync` payload change. The `HTML_KV` cache key prefix from
feature 015 (`html:v2:`) is unchanged.
**Testing**: Existing tapout-based tests under `test/`. New unit test
coverage for the dev-gating logic (extracted as a pure function so it
can be tested without a Vite environment), plus an extension to
`test/lazy-html.ts` that asserts the dev branch is wired correctly. A
regex-based source-grep test asserts no `await import(<identifier>)`
patterns exist in `src/server/`.
**Target Platform**: Browser (Preact SPA) for the rendering side;
Cloudflare Workers for the worker. Dev uses Vite + `wrangler dev` via
`@cloudflare/vite-plugin` on port 2222. Prod runs on Cloudflare.
**Project Type**: Web application — frontend (`src/client/`) +
backend (`src/server/`). Only the worker entry (`src/server/index.ts`)
is modified in `src/`.
**Performance Goals**: SC-001 — first styled paint within 1.5s in dev
on a warm dev server. SC-002 — zero un-analyzable-import warnings.
SC-003 — zero unstyled frames between navigation start and FCP. SC-005
— production parity with feature 015 (every prod outcome from 015
holds).
**Constraints**: Must hold for every top-level route. Must not
introduce CLS (FR-007). Must not regress production (FR-006). Lazy
load of `blurhash-runtime` must remain a separate chunk (FR-005).
Other un-analyzable dynamic imports — confirmed during exploration
that `src/server/index.ts:1493` is the only such case in the codebase
(`src/server/durable-objects/index.ts:2492`,
`src/client/db/sqlite-init.ts:71`,
`src/client/db/sqlite-worker.ts:183` all use literal strings) — so
FR-008 is satisfied by fixing the one site.
**Scale/Scope**: One source file modified (`src/server/index.ts`),
one helper extracted for testability, one new unit test file (or
extension), one quickstart entry. No new state, no new component, no
new route, no schema change.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against principles I–V from
`.specify/memory/constitution.md`:

- **I. Local-First Reads** — PASS. No new read path. The change is
  upstream of `localAdapter` / `remoteAdapter` and does not alter what
  the client reads or where from.
- **II. Idempotent, Outbox-Backed Sync** — PASS. No mutation, no
  outbox entry, no `/api/sync` payload change. The lazy-HTML cache
  key from feature 015 is unchanged; the dev branch simply does not
  consult the cache.
- **III. Edge-Native Topology** — PASS. The Worker + per-user DO
  topology is unchanged. The dev branch short-circuits before any
  DO call. In production the request path is byte-identical to today.
- **IV. Capability-Gated Progressive Enhancement** — PASS. No service
  worker change. Local-first capability gating
  (`syncSubscriptions`, OPFS, COOP/COEP) is unaffected. The dev FOUC
  fix lives entirely in the worker; client capability detection is
  not touched.
- **V. Bluesky-Anchored Identity** — PASS. No auth change. The
  session is still consulted in production; the dev branch is the
  short-circuit and runs before `c.get('session')` would matter.

No violations. No Complexity Tracking entries needed.

**Re-check after Phase 1 design**: PASS. Phase 1 introduces no new
entities, no new server contracts, no new schemas — see
`data-model.md` (no changes) and `contracts/README.md` (records the
two internal contracts: the dev-gating predicate and the literal-
import source assertion). The `research.md` decisions all preserve
every gate.

## Project Structure

### Documentation (this feature)

```text
specs/016-fix-dev-server-fouc/
├── plan.md              # This file
├── research.md          # Phase 0: dynamic-import literal vs. variable;
│                        #   dev FOUC fix options; dev-detection
│                        #   mechanism
├── data-model.md        # Phase 1: notes that no entities exist
├── quickstart.md        # Phase 1: how to manually verify in browser
├── contracts/
│   └── README.md        # Two internal contracts: dev-gating
│                        #   predicate, and the no-variable-import
│                        #   source assertion
└── tasks.md             # Phase 2 output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── server/
│   └── index.ts                    # MODIFIED:
│                                   # 1. line ~1489-1495: rewrite
│                                   #    `await import(blurhashRuntimeModule)`
│                                   #    as a literal
│                                   #    `await import('./blurhash-runtime.js')`
│                                   #    and remove the now-unused
│                                   #    `blurhashRuntimeModule` constant.
│                                   # 2. line ~1467-1487 (`app.all('*')`):
│                                   #    after the `c.env?.ASSETS` guard,
│                                   #    add an `import.meta.env.DEV`
│                                   #    short-circuit that returns
│                                   #    `c.env.ASSETS.fetch(c.req.raw)`
│                                   #    before reaching the lazy-HTML
│                                   #    branch. Helper predicate
│                                   #    `shouldSkipLazyHtml(env)` is
│                                   #    extracted so the gating logic
│                                   #    is unit-testable independently
│                                   #    of `import.meta`.
│
├── client/                         # NOT MODIFIED
└── shared/                         # NOT MODIFIED

test/
├── lazy-html.ts                    # EXTENDED: assert
│                                   #   `shouldSkipLazyHtml` returns
│                                   #   true when its `dev` arg is true,
│                                   #   false otherwise. Locks the dev
│                                   #   branch in.
└── server-import-shape.ts          # NEW: regex-based source assertion
                                    #   that no `await import(<ident>)`
                                    #   pattern (variable, not literal)
                                    #   exists under `src/server/`.
                                    #   Catches future regressions of
                                    #   the Vite warning.
```

**Structure Decision**: Existing `src/client/` + `src/server/` +
`src/shared/` web-app layout is kept. Only `src/server/index.ts` is
modified in `src/`; the changes are localized to the dynamic-import
site (~lines 1489-1495) and the catch-all asset handler (~lines
1467-1487). One test extension and one new test file land under
`test/`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be
> justified**

No violations. No entries.
