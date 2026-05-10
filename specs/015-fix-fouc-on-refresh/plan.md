# Implementation Plan: Fix Flash of Unstyled Content on Page Refresh

**Branch**: `015-fix-fouc-on-refresh` | **Date**: 2026-05-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/015-fix-fouc-on-refresh/spec.md`

## Summary

The app's `index.html` currently does not link any stylesheet. All CSS
is pulled in transitively from JavaScript:
`src/client/index.ts:12` — `import './style.css'`, plus per-component
imports such as `src/client/components/header.ts:11` —
`import './header.css'`. In production Vite extracts those CSS imports
to a hashed bundle and *injects a `<link rel="stylesheet">` into the
built HTML*; in Vite dev (`npm start`, port 2222) it does **not** —
the stylesheets are loaded as JS modules that inject `<style>` tags at
runtime, after the entry script has parsed and evaluated.

For most of the project's life the dev FOUC was effectively invisible
because the body contained only `<div id="root"></div>` — there was
nothing to paint unstyled before the JS ran. Recent commits on this
branch (`5e9bf17 US-021 Consume initial feed bootstrap`,
`9c123bd US-020 Wire lazy HTML route`, `e6ac76d US-019 Add lazy HTML
handler`) changed that: the lazy HTML pipeline now seeds rendered feed
markup into `#root` (`src/server/lazy-html.ts:44-71`) before the
client JS loads. The seeded markup paints with browser defaults
(unstyled blue underlined links — see the screenshot in the spec)
until the JS bundle loads, evaluates, and only then injects the CSS.
That is the user-visible regression.

The fix is to make the served HTML reference the app's stylesheet
*directly* via `<link rel="stylesheet">` in `<head>`, so the browser
fetches CSS in parallel with HTML and blocks the first paint until
the stylesheet is applied. Mechanically: add a `<link>` tag to the
single source `index.html` pointing at the existing
`src/client/style.css` (Vite resolves this to the dev module in `npm
start` and to a hashed bundle file in the production build).

Two follow-ons fall out of this:

1. The lazy HTML handler caches built HTML in `HTML_KV`
   (`src/server/lazy-html-handler.ts:75-77`). Existing cached entries
   were captured when `index.html` had no `<link>`. The cache key is
   currently `html:<did>:<feed-version>`
   (`src/server/lazy-html.ts:9-14`). To prevent serving stale,
   FOUC-y HTML, the cache key is bumped to a new schema-versioned
   prefix `html:v2:<did>:<feed-version>` so every existing entry is
   ignored and rewritten on first hit.
2. A regression guard asserts on the build artifact: the built
   `public/index.html` MUST contain a `<link rel="stylesheet" ...>`
   in `<head>` *before* any `<script>` tag. This catches future
   refactors that remove the link or move it after a script.

The decision matrix for *how* to load the CSS (link vs preload vs
inline-critical-css) and the trade-offs are in `research.md`
Decision 1.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for
the client; Cloudflare Workers ES2022 for the server lazy-html
handler — both touched).
**Primary Dependencies**: Vite 7 + lightningcss (CSS pipeline),
Preact + `@preact/signals` (rendering — not modified), Hono
(server — only the lazy HTML cache key constant changes).
**Storage**: N/A. No SQLite schema change, no DO schema change, no
`/api/sync` payload change. Only the existing `HTML_KV` cache key
schema rolls forward (`v1` → `v2`).
**Testing**: Existing tapout-based browser tests under `test/`,
plus one new `test/lazy-html-shell.ts` (or extension to
`test/lazy-html.ts`) that asserts the built `public/index.html` shell
contains a `<link rel="stylesheet">` in `<head>` ahead of any
`<script>` tag.
**Target Platform**: Browser (Preact SPA) for the rendering side;
Cloudflare Workers for the lazy HTML handler. Both run in dev under
Vite + wrangler dev (port 2222) and in prod on Cloudflare.
**Project Type**: Web application — frontend (`src/client/`) +
backend (`src/server/`). The client side gets the `index.html` link
change; the server side gets a one-line cache-key constant bump.
**Performance Goals**: Time-to-first-contentful-paint on the feed
view does not regress by more than 10% relative to the current
baseline (SC-002). Net effect should be neutral-to-positive: the
stylesheet is already required to render styled content, the only
question is whether the browser fetches it in parallel with HTML
(this fix) or sequentially after the JS module evaluates (today).
**Constraints**: Must hold on cold cache and warm cache (FR-002),
under a slow-3G profile (FR-002), and across every top-level route
(FR-001 / US-2). Must not introduce CLS (FR-003). Must work in every
currently supported browser (FR-006) — `<link rel="stylesheet">` is
available everywhere; no browser-feature-flag trade-offs.
**Scale/Scope**: Two source files modified (`index.html`,
`src/server/lazy-html.ts`), one or two test files added/extended.
No new dependencies. No new state, no new component, no new route.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against principles I–V from
`.specify/memory/constitution.md`:

- **I. Local-First Reads** — PASS. No new read path. The fix changes
  how the browser loads a stylesheet; it does not introduce or alter
  any data read. `localAdapter` / `remoteAdapter` are not involved.
- **II. Idempotent, Outbox-Backed Sync** — PASS. No mutations, no
  outbox entries, no new server data handler. The only server-side
  change is a cache-key string constant in
  `src/server/lazy-html.ts` (`html:` → `html:v2:`); the rest of
  the lazy HTML pipeline (idempotency, version-keying, KV TTL) is
  unchanged.
- **III. Edge-Native Topology** — PASS. The Worker-+-DO topology is
  not touched. The cache-key bump invalidates a one-shot rendering
  cache and is conceptually equivalent to a TTL expiry that already
  happens every 30 days (`HTML_CACHE_TTL_SECONDS`,
  `src/server/lazy-html-handler.ts:9`).
- **IV. Capability-Gated Progressive Enhancement** — PASS. The fix
  works identically under `localAdapter` and `remoteAdapter` because
  CSS loading is upstream of either one. No service worker is
  introduced (would be a constitutional amendment).
- **V. Bluesky-Anchored Identity** — PASS. No auth change.

No violations. No Complexity Tracking entries needed.

**Re-check after Phase 1 design**: PASS. Phase 1 introduces no new
entities, no new server contracts, no new schemas — see
`data-model.md` (empty deltas) and `contracts/README.md` (records the
single shell-contract assertion the build artifact test guards). The
`research.md` decisions (link in HTML, cache key bump, build
artifact guard) all preserve every gate.

## Project Structure

### Documentation (this feature)

```text
specs/015-fix-fouc-on-refresh/
├── plan.md              # This file
├── research.md          # Phase 0: link vs preload vs inline; cache
│                        #   bump strategy; regression guard choice
├── data-model.md        # Phase 1: notes that no entities exist
├── quickstart.md        # Phase 1: how to manually verify in browser
├── contracts/
│   └── README.md        # The one shell contract: link-in-head,
│                        #   pre-script, asserted by build artifact
│                        #   test
└── tasks.md             # Phase 2 output (NOT created here)
```

### Source Code (repository root)

```text
index.html                       # MODIFIED: add
                                 #   <link rel="stylesheet"
                                 #         href="/src/client/style.css">
                                 #   in <head>, before the existing
                                 #   <script type="module" src=...>

src/
├── client/
│   ├── index.ts                 # NOT MODIFIED — keep
│   │                            #   `import './style.css'` for HMR
│   │                            #   ergonomics (Vite dedupes; the
│   │                            #   <link> is the binding edge that
│   │                            #   matters for first paint)
│   ├── style.css                # NOT MODIFIED — already the entry
│   │                            #   stylesheet (@imports
│   │                            #   feed-reader.css, _variables.css)
│   └── (component CSS)          # NOT MODIFIED — co-located CSS
│                                #   imports continue to work via JS;
│                                #   they are not first-paint-critical
│                                #   for the seeded feed markup
├── server/
│   ├── lazy-html.ts             # MODIFIED: bump cache key prefix
│   │                            #   from `html:` to `html:v2:` so
│   │                            #   pre-fix cached entries are
│   │                            #   ignored. One-line change in
│   │                            #   buildLazyHtmlCacheKey().
│   └── lazy-html-handler.ts     # NOT MODIFIED — handler keeps
│                                #   serving whatever `index.html`
│                                #   from ASSETS contains; the
│                                #   `<link>` flows through verbatim
└── shared/                      # NOT MODIFIED

test/
├── lazy-html.ts                 # EXTENDED: assert
│                                #   buildLazyHtmlCacheKey returns a
│                                #   `v2:` prefixed string (lock the
│                                #   schema version)
└── shell-html.ts                # NEW: build-artifact test that
                                 #   asserts `public/index.html`
                                 #   after `npm run build` contains a
                                 #   <link rel="stylesheet"> in
                                 #   <head> before any <script>
```

**Structure Decision**: Existing `src/client/` + `src/server/` +
`src/shared/` web-app layout is kept. Only `index.html` and
`src/server/lazy-html.ts` are modified in `src/`; one test extension
and one new test file land under `test/`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be
> justified**

No violations. No entries.
