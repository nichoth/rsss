# Phase 0 Research: Fix Flash of Unstyled Content on Page Refresh

## Decision 1: How does the served HTML reference the app's CSS?

**Context.** Today `index.html` has no `<link rel="stylesheet">`. CSS
arrives only as a side-effect of executing
`src/client/index.ts:12` — `import './style.css'`. In production, Vite
extracts that import to a hashed CSS bundle and injects a `<link>`
into the built `public/index.html`. In Vite dev (`npm start` on port
2222) Vite does *not* inject a `<link>`; it serves CSS imports as JS
modules that inject `<style>` at runtime. With the lazy HTML pipeline
seeding actual feed markup into `#root` server-side
(`src/server/lazy-html.ts:44-71`), the dev path now paints visible
unstyled content for the entire JS-load → JS-evaluate → CSS-inject
window. That is the screenshot in the spec.

The spec's hard requirement (FR-001) is that the *first painted
frame* is app-styled, in dev *and* prod, on warm cache *and* cold,
on fast network *and* slow.

Three options were evaluated:

- **A. Add `<link rel="stylesheet" href="/src/client/style.css">`
  to `index.html`'s `<head>`, before the existing `<script
  type="module">`.**
  - Vite dev: serves the CSS module as a real CSS response (with
    HMR). Browser blocks first paint on the stylesheet, exactly as
    it does for any other linked stylesheet.
  - Vite prod: the build pipeline rewrites the link to point at the
    hashed CSS bundle in `public/assets/...`. Already the behavior
    today for any `<link>` inside an HTML entry — Vite's HTML
    pre-processor handles it.
  - Net effect: one new line of HTML, no JS changes, no build-config
    changes. Fixes dev *and* keeps prod correct.

- **B. Inline a critical-CSS block in `<head>` and load the rest
  asynchronously.**
  - Strictly faster TTFCP for the seeded-feed paint than A, because
    the critical CSS arrives in the same response as the HTML.
  - Cost: needs a critical-CSS extraction pipeline (a Vite plugin or
    a build script that walks the DOM for the seeded shell and
    pulls the matching rules from `style.css`/component CSS). The
    seeded markup uses classes from at least three CSS files
    (`style.css`, `feed-reader.css`, plus the BlurHash component's
    own styles for `<blur-hash>`). Maintaining a critical-CSS
    extractor is a much larger surface than the spec needs.
  - The spec's SC-002 budget (≤10% TTFCP regression) only requires
    that we not make TTFCP *worse*; it does not require us to make
    it better. A is already neutral-to-positive.

- **C. Preload the CSS via `<link rel="preload" as="style">` and
  swap to `rel="stylesheet"` via JS.**
  - Common "FOUC-free without blocking" recipe. Useful when CSS is
    huge and you want to start loading early *without* blocking
    paint. That is the opposite of what the spec wants — the spec
    *wants* paint to wait for CSS so the user never sees the
    unstyled state.
  - Also adds JS that runs before paint, which is fragile under the
    very slow-network conditions we are testing for.

**Decision.** Use **A**: a single `<link rel="stylesheet"
href="/src/client/style.css">` in `<head>`, placed before the
existing `<script type="module" src="/src/client/index.ts">`.

**Rationale.**

1. **Solves the bug at its source.** The browser's own
   render-blocking-stylesheet behavior is exactly the guarantee the
   spec asks for. Once the stylesheet is in `<head>` the browser
   will *not* paint the seeded feed markup until the CSS has
   loaded. FR-001 holds by construction in every supported browser.
2. **Symmetric across dev and prod.** Both modes already handle
   `<link rel="stylesheet">` in entry HTML — dev serves the file
   directly with HMR, prod's build pipeline rewrites and bundles
   the href. No mode-specific shim. FR-005 (works for the lazy HTML
   path *and* any other delivery path) holds because the lazy HTML
   handler just relays whatever `index.html` ASSETS gives it
   (`src/server/lazy-html-handler.ts:60-73`).
3. **No CLS introduced.** The page already had to load this CSS to
   render correctly; the only change is *when* the browser fetches
   it. Layout dimensions are unchanged between "no CSS yet" and
   "CSS loaded" only because today the no-CSS state is *visible*;
   making it block paint removes the visible state without
   reshaping the laid-out one. FR-003 holds.
4. **Keeps the JS-side `import './style.css'` working.** The
   import in `src/client/index.ts:12` is left alone. In dev that
   import enables HMR for the entry stylesheet (a `<link>` with
   the same href is already HMR-tracked by Vite, and the duplicate
   import is deduped). In prod the import is hoisted into the same
   extracted CSS bundle the `<link>` resolves to. No change in
   produced CSS, no change in produced JS.

**Alternatives considered.**

- **B (inline critical CSS)** — rejected per Cost above. The spec
  budget does not require inlined critical CSS, and the maintenance
  cost of a critical-CSS extractor is high relative to the bug.
- **C (preload + swap)** — rejected per Spec mismatch above. Preload
  is for "load early, render anyway"; the spec wants "render only
  after CSS is applied".
- **Inline `<style>` containing the entire `style.css`** — rejected:
  defeats Vite's CSS pipeline (lightningcss minify, browserslist
  targeting, the `@import` chain in `style.css`), and the inlined
  bytes ride every HTML response forever. KV would also cache the
  inlined CSS per-user under the lazy HTML key, multiplying KV
  storage cost.
- **Move the `import './style.css'` to a synchronous loader script in
  `<head>`** — rejected: still ships CSS as JS-injected `<style>` in
  dev, which still flashes; doesn't solve the user's bug.

## Decision 2: How are existing `HTML_KV` cache entries invalidated?

**Context.** The lazy HTML handler caches the rendered shell+seed
under `html:<did>:<feed-version>` for 30 days
(`src/server/lazy-html.ts:9-14`,
`src/server/lazy-html-handler.ts:9`). Entries written *before* this
fix were captured when `index.html` had no stylesheet link; they
will continue to FOUC even after the fix ships. Cache invalidation
options:

- **A1. Bump the key prefix from `html:` to `html:v2:`.** Existing
  entries become unreachable. New writes occupy a new keyspace. Old
  entries expire naturally via the 30-day TTL.
- **A2. Wait for TTL.** Up to 30 days of post-deploy FOUC for any
  user whose pre-deploy cache hit is still warm.
- **A3. Hash the rendered shell.** Encode a hash of the
  shell-template into the cache key (e.g.
  `html:<shell-hash>:<did>:<feed-version>`). Future shell changes
  self-invalidate without a manual bump.
- **A4. List + delete via the KV admin tools.** Operational toil; KV
  list is paginated and not designed for fan-out delete.

**Decision.** Use **A1** for this fix and note A3 as a follow-up.

**Rationale.**

1. **Correctness on day 1.** A1 guarantees zero pre-fix entries are
   served the moment the new code deploys. A2 fails this; the spec's
   SC-004 ("zero user-visible recurrences after the fix ships")
   would be violated for up to 30 days otherwise.
2. **Smallest possible change.** A1 is a one-line edit to a string
   literal in `buildLazyHtmlCacheKey` — fully reviewable, fully
   reversible, and easily extended into A3 in a future commit if
   the shell template starts changing more often.
3. **A3 is the right long-term answer but is out of scope here.** It
   adds a build-time step (compute and inject the shell hash) and a
   read-time step (parse the hash on KV miss). Worth doing on its
   own merit; not worth coupling to a FOUC fix.

**Alternatives considered.** A2/A3/A4 above. A2 is unsafe; A3 is
larger than the spec; A4 is operationally fragile.

## Decision 3: What automated regression guard does FR-007 satisfy?

**Context.** Spec FR-007 says the fix SHOULD include "some form of
automated detection (a check, test, or recorded baseline) that fails
when a page refresh once again paints unstyled content." Three
options:

- **G1. Build-artifact assertion.** After `npm run build`, parse
  `public/index.html`. Assert: contains a `<link rel="stylesheet">`
  inside `<head>`, and the position of the *first* `<link
  rel="stylesheet">` in the document is before the position of the
  *first* `<script>` tag. (Order matters because a stylesheet that
  comes after a sync script can defer paint behind script execution
  in some browsers.)
- **G2. Browser test under tapout/tapzero with throttled network.**
  Open the dev server, throttle network, take a series of
  screenshots starting at the first paint, OCR/pixel-diff to detect
  default-blue underlined links.
- **G3. Lighthouse / Web Vitals budget on CI.** Track a
  `cumulative-layout-shift` and a custom "first-paint-was-styled"
  metric.

**Decision.** Use **G1** as the primary guard.

**Rationale.**

1. **Failure mode it catches.** The bug is, at root, a missing
   `<link>` in the served shell. G1 asserts exactly the shape of
   the shell. Any future refactor that drops the link (or moves it
   after a script) trips the test.
2. **No browser harness needed.** G1 runs in node, takes
   milliseconds, slots into the existing `npm test` pipeline next to
   `test/lazy-html.ts`. G2 and G3 require a headless browser stack
   the project does not currently maintain.
3. **Coverage is the right shape.** G1 covers the *served shell*,
   which the lazy HTML handler relays verbatim
   (`src/server/lazy-html-handler.ts:60-73`). If the shell is
   correct, every cache entry written from it is correct. G2 only
   covers the routes the test happens to hit; G1 covers the asset
   that backs every route.

**Alternatives considered.** G2/G3 above. G2 is not rejected
*forever* — it is the right shape for catching regressions in CSS
*content* (e.g. a rule that breaks the seeded feed at a narrow
viewport). G1 catches the *delivery* regression, which is the one
this spec is about. G3 is much larger than the spec.

## Decision 4: Are co-located component CSS imports left alone?

**Context.** Around 25 component/route CSS files are imported via JS
(e.g. `src/client/components/header.ts:11` —
`import './header.css'`). Should those move to `<link>` tags in
`index.html` too?

**Decision.** No. Leave the component CSS imports alone.

**Rationale.**

1. **They are not first-paint-critical for the seeded shell.** The
   seeded markup (`src/server/lazy-html.ts:55-66`) uses these
   classes: `route feed-reader`, `app-body`, `content`,
   `items-list`, `item-row`, `unread`, `item-link`,
   `with-thumbnail`, `item-thumbnail`, `item-main`, `item-title`,
   `item-meta`, `item-feed`, `item-date`, `item-excerpt`. All of
   them are defined in `src/client/style.css` or its `@import`
   chain (`feed-reader.css`, `_variables.css`). The component CSS
   files cover post-hydration UI (sidebar interactions, settings
   panels, etc.) which the user does not see in the first paint of
   a refresh.
2. **In production, Vite extracts every CSS import to the same
   linked bundle.** Because component CSS is reachable from the
   entry chain at build time, it ends up in the same hashed CSS
   file the new `<link>` points to. Production behavior is
   unchanged.
3. **In dev, the FOUC user-visibly reported is on the first paint
   of `<root>`'s seeded content** — fixing the entry stylesheet's
   load timing fixes that. Component CSS that arrives slightly
   after first paint affects only post-hydration UI states; those
   don't FOUC because Preact has already rendered them with the
   entry stylesheet's typography/colors applied.
4. **Keeps the per-component HMR ergonomics.** Editing
   `header.css` and getting a hot reload is a real ergonomic win
   in dev; converting every component CSS to a `<link>` would
   trade that for nothing the spec requires.
