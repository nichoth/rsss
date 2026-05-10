# Contracts: Fix Flash of Unstyled Content on Page Refresh

This feature exposes no new public/external interface — no new HTTP
route, no new RPC call, no new SDK. The single contract introduced
is an *internal build-artifact contract* on the served HTML shell,
which exists to enforce spec FR-007 (an automated regression guard).

## Shell contract

**Subject.** `public/index.html` produced by `npm run build`.

**Asserted by.** `test/shell-html.ts` (new), runnable via
`node --test` or wired through the existing `npm test` aggregator
in `test/run-all-tests.mjs`.

**Invariants.**

1. The document SHALL contain at least one
   `<link rel="stylesheet" href="...">` element.
2. The first `<link rel="stylesheet">` element SHALL appear inside
   `<head>` (i.e. its character offset SHALL be greater than the
   offset of `<head>` and less than the offset of `</head>`).
3. The character offset of the first `<link rel="stylesheet">`
   SHALL be strictly less than the offset of the first `<script>`
   tag in the document.

**Failure modes the contract catches.**

- A future refactor removes `<link rel="stylesheet">` from
  `index.html`. (Invariant 1.)
- A future refactor moves the `<link>` after `</head>` or into
  `<body>`. (Invariant 2.)
- A future refactor inserts a `<script>` before the `<link>` (or
  Vite's HTML processor changes its emission order). (Invariant 3.)

**Failure modes the contract does NOT catch.** This contract does
not verify rendered pixel output, network behavior under throttle,
or layout-shift metrics. Those are covered by the manual quickstart
checks (see `quickstart.md`) — adding browser-pixel verification is
out of scope per `research.md` Decision 3.

## Lazy-HTML cache key contract (internal, unchanged shape)

The cache-key string produced by `buildLazyHtmlCacheKey`
(`src/server/lazy-html.ts:9-14`) is an internal contract between the
write site (`src/server/lazy-html-handler.ts:75-77`) and the read
site (`src/server/lazy-html-handler.ts:46-49`). No external consumer
depends on the string format.

**Asserted by.** Extension to `test/lazy-html.ts`.

**Invariant after this change.**

- `buildLazyHtmlCacheKey(did, version)` SHALL return a string that
  begins with the literal `"html:v2:"`. This locks the schema
  version forward; if the shell template ever needs to change
  shape again, the next change MUST bump to `v3:` and update the
  test.
