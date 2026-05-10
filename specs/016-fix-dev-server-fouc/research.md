# Phase 0 Research: Fix Dev Server FOUC and Vite Dynamic-Import Warning

## Decision 1: How to silence the un-analyzable dynamic-import warning

**Context.** `src/server/index.ts:1489-1495`:

```ts
const blurhashRuntimeModule = './blurhash-runtime.js'

const worker = Object.assign(app, {
    async queue (batch:MessageBatch<unknown>, env:Env):Promise<void> {
        const runtime = await import(
            blurhashRuntimeModule
        ) as typeof BlurhashRuntime
        ...
    }
})
```

Vite warns because the argument to `import(...)` is an identifier
(`blurhashRuntimeModule`), not a string literal or template literal
with only literal parts. Vite's static analyzer does not perform
constant-folding across binding declarations. Even though humans can
trivially see the value is fixed at the line above, Vite refuses to
treat it as a known import target — the warning text is ``"…dynamic
import will not be moved to a separate chunk."``

The lazy-load *intent* of the call is legitimate. `blurhash-runtime.js`
imports `@cf-wasm/photon` (heavy WASM) and the BlurHash queue handling
plumbing. The synchronous worker entry should not pull that into the
default startup graph; it is only needed inside `queue()`, which the
edge runtime calls separately from the request path.

Three options were evaluated:

- **A. Inline the literal at the import site.** Replace
  `await import(blurhashRuntimeModule)` with
  `await import('./blurhash-runtime.js')` and delete the
  `blurhashRuntimeModule` constant.
  - Vite recognizes the literal, emits a separate chunk, no warning.
  - The lazy-load semantics are preserved by definition: any literal
    `import(...)` becomes its own chunk under Vite's default chunking.
  - Zero behavioral change. One-line refactor.

- **B. Use a `/* @vite-ignore */` comment to suppress the warning.**
  - Silences the warning but disables chunk extraction (Vite leaves
    the import as an opaque runtime call). That makes the lazy-load
    semantics dependent on the runtime's `import()` implementation,
    which under Cloudflare workers loads from the bundled output.
  - Hides a real diagnostic instead of fixing it. Future
    un-analyzable imports would also need ignore comments, training
    the team to suppress warnings.

- **C. Convert to a static `import` at the top of the file.**
  - Cheapest mechanically — no warning, no special case.
  - Defeats the purpose: `blurhash-runtime.js` and its WASM
    dependency would be eagerly loaded into the worker's startup
    graph, growing the cold-start size of every request.
  - Violates FR-005 ("MUST preserve lazy-load semantics").

**Decision: A.** Replace the variable with a literal string at the
import site. Verify post-fix that `npm run build` produces a separate
chunk for `blurhash-runtime` (e.g. by running `find public -type f`
and confirming a `blurhash-runtime`-named chunk exists outside the
main worker bundle). If for any reason the literal still does not
cleave a chunk in the final build, that is a Vite/cloudflare-plugin
configuration issue separate from this spec, but the warning will be
gone.

## Decision 2: How to eliminate the dev FOUC and wrong-route flash

**Context.** Three separable contributors produce the visible symptom:

1. **The lazy-HTML pipeline runs in dev.** It seeds rendered feed-item
   markup into `#root` for any authenticated request, regardless of
   route (`src/server/index.ts:1467-1487`,
   `src/server/lazy-html-handler.ts`). The handler does not check the
   request path against a route table — it is keyed only on `did`,
   `HTML_KV`, and `USER_DO`, all three of which are bound in the dev
   wrangler config (`wrangler.jsonc:39-58`).
2. **In dev, JS-imported component CSS is not extracted to a `<link>`.**
   Vite dev serves CSS imports
   (`src/client/components/header.ts:11` →
   `import './header.css'`, plus item-row, sidebar, page-skeleton, …)
   as JS modules that inject `<style>` tags at JS evaluation time.
   In production the same imports are extracted into the bundled CSS
   `<link>` Vite emits during build.
3. **Feature 015's `<link>` only covers `style.css` and its
   `@import` chain.** That is `feed-reader.css`, `_variables.css`,
   normalize, a11y, check-box, tool-tip, blur-hash CSS,
   hamburger-two CSS, details-summary CSS — but **not** the
   per-component CSS imported by JS modules (header, sidebar,
   item-row, page-skeleton, dot, button, etc.).

The composition of (1)+(2)+(3) is the bug: the seeded markup paints
with only `style.css` applied, which covers `body`, `.route`,
`.app-body`, `.content`, the login form, etc., but does *not* cover
`.items-list`, `.item-row`, `.item-link`, `.item-thumbnail`,
`.item-main`, `.item-title`, `.item-meta`, `.item-feed`,
`.item-date`, `.item-excerpt`, `.sidebar`, `.header`, etc. Those
classes paint with browser defaults — link blue, no flex layout, no
borders — until the JS bundle finishes evaluating and component CSS
modules inject their `<style>` tags.

The wrong-route flash falls out of the same root cause: the lazy
handler seeds feed items even when the URL is `/login`, so the user
sees article markup until the SPA router runs and replaces `#root`
with the login UI.

Three options were evaluated:

- **A. Skip lazy-HTML seeding in dev.** Detect dev with
  `import.meta.env.DEV` (`@cloudflare/vite-plugin` substitutes this
  in worker code at build time, the same way Vite does for client
  code — used today at `src/client/index.ts:30` and
  `src/client/routes/login.ts:68`). When `DEV` is true, the catch-all
  handler falls through to `c.env.ASSETS.fetch(c.req.raw)` — the
  unseeded shell. The empty `<div id="root"></div>` paints, the JS
  bundle loads, evaluates, and the route renders styled. No unstyled
  flash because there is no seeded markup to paint unstyled. No
  wrong-route flash because there is no seeded markup at all.
  - Cost: dev no longer mirrors prod's seeded first-paint. That
    mirror was useful for verifying lazy-HTML output, but the
    lazy-HTML logic is also exercised by `test/lazy-html.ts` and by
    actual prod usage. Losing dev mirror is acceptable.
  - Five-line change. Zero new code paths in production.

- **B. Inject `<link>` tags in dev for every JS-imported CSS.** Write
  a Vite dev plugin that walks `server.moduleGraph` from the client
  entry, collects every CSS module URL, and adds them as `<link>`
  tags via `transformIndexHtml`. The dev request flow keeps seeding
  feed markup, and component CSS arrives synchronously like in prod.
  - ~80 LOC of plugin code. Module-graph traversal needs to handle
    HMR (the graph mutates), CSS-in-JS (the `?inline` query),
    and the `?direct` query pattern Vite uses for `<style>` tag
    injection. Tests need a Vite dev-server harness.
  - Doesn't fix the wrong-route flash. The lazy handler would still
    seed article markup on `/login`.

- **C. Move all component CSS into `style.css` via `@import`.** Add
  one `@import url("./components/X.css")` line per component CSS
  file. The single existing `<link>` then covers everything.
  - Works in dev *and* prod with no special-casing.
  - Permanent maintenance overhead: every new component CSS file must
    also be `@imported` here, and the order matters because
    `@import` rules cannot be interleaved with regular rules. Easy to
    forget. Also doesn't fix the wrong-route flash.
  - Reorganizes a piece of CSS architecture (per-component coupling)
    in service of fixing a dev-only artifact, which is heavier than
    the spec needs.

**Decision: A.** Skip lazy-HTML seeding in dev. Single root cause
(seeding in dev) addressed; both reported symptoms (FOUC, wrong-route
flash) eliminated; production unchanged; no new build infrastructure;
no architectural reorganization. The cost — losing dev mirror of the
seeded HTML — is small and recoverable: the unit test
`test/lazy-html.ts` and the production environment both exercise the
seeded path, and a developer who specifically wants to inspect
seeded HTML can do so against staging or by temporarily removing the
gate.

## Decision 3: Where to detect "dev"

**Context.** Decision 2 needs a runtime signal that says "this is the
Vite dev server, not Cloudflare prod." The signal must be available
in worker code (`src/server/index.ts`), must be statically replaced
in production builds so the dev branch is dead-code-eliminated, and
must not depend on infrastructure config the developer might forget
to set.

Three options were evaluated:

- **A. `import.meta.env.DEV`.** Vite's compile-time constant. Set to
  `true` in dev, `false` (literal) in any non-dev mode. Replaced at
  build time, so the dev branch is dead-code-eliminated in production
  (verified by inspecting `public/_worker.js/index.js` after
  `npm run build` — the branch should not appear).
  - `@cloudflare/vite-plugin` runs the worker through Vite's
    environment pipeline, which performs the same `import.meta.env`
    substitutions on worker code as on client code. Already used in
    client code at `src/client/index.ts:30` and
    `src/client/routes/login.ts:68`.
  - One-line condition. No env var to set. No infrastructure config
    to forget.

- **B. `c.env` env var.** Add `vars: { ENVIRONMENT: "production" }`
  to `wrangler.jsonc` and a `--var ENVIRONMENT=dev` to a dev script.
  - Explicit but two-place: changing the convention requires updating
    both files. Easy to misconfigure.
  - Survives static replacement: branch stays in production bundle.
    Not strictly a problem (worker honors the env var) but defeats
    dead-code elimination.

- **C. Host header check** (`request.headers.get('host')`). Match
  `127.0.0.1:2222` or `localhost:2222`.
  - Brittle: any dev port change requires updating the matcher; any
    test that hits the worker over a non-loopback host would also
    skip. Pure runtime check, no DCE.

**Decision: A.** `import.meta.env.DEV` is the idiomatic Vite signal,
already used elsewhere in this codebase, and dead-code-eliminated in
production. The gating logic is wrapped in a small helper
`shouldSkipLazyHtml({ dev:boolean }):boolean` so the predicate is
unit-testable without bringing up Vite.

## Decision 4: Regression guards

**Context.** Spec FR-009 asks for a guard that catches a regression
of the dev FOUC. Spec FR-008 implicitly asks for a guard against
re-introducing un-analyzable dynamic imports.

Three guard mechanisms were evaluated:

- **A. Pixel/screen-recording regression test.** Run dev server,
  drive a headless browser, capture frames, assert no frame between
  navigation start and FCP shows browser-default link blue.
  - High fidelity but high infra cost: requires Playwright or
    similar, dev server orchestration, frame extraction. Heavy
    relative to spec scope.

- **B. Source-shape assertions.** A unit test asserts the literal
  string `await import('./blurhash-runtime.js')` (or any other
  literal-only `await import('...')` form) is the only shape used
  under `src/server/`. A second unit test asserts the dev-gating
  predicate (`shouldSkipLazyHtml`) returns the right values.
  - Cheap. Catches the regressions that matter (variable-form
    dynamic import; removing the dev gate). Misses pixel-level
    drift, but that is rare without a deliberate code change.

- **C. Manual quickstart verification.** Document the steps to load
  the dev server with DevTools' performance trace and confirm no
  unstyled frames. Owned by the developer at PR-review time.
  - Zero infra. Catches regressions only when someone runs it.

**Decision: B + C.** B for the cheap automation (added to
`test/lazy-html.ts` and a new `test/server-import-shape.ts`), C as
the documented manual step in `quickstart.md`. A is rejected for
this scope; if dev FOUC regressions become a recurring problem, a
pixel-trace test can be added later.
