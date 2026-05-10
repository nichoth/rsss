# Contracts: Fix Dev Server FOUC and Vite Dynamic-Import Warning

This feature exposes no new public/external interface — no new HTTP
route, no new RPC call, no new SDK, no schema change. The two
contracts introduced are *internal* and exist only to enforce spec
FR-008 and FR-009 (regression guards).

## Contract 1: Dev-gating predicate

**Subject.** A pure function exported from `src/server/index.ts`
(or a small helper module imported by it):

```ts
export function shouldSkipLazyHtml (
    args:{ dev:boolean }
):boolean {
    return args.dev
}
```

The catch-all asset handler (`app.all('*')`) calls
`shouldSkipLazyHtml({ dev: import.meta.env.DEV })` and, when the
return is `true`, falls through to `c.env.ASSETS.fetch(c.req.raw)`
*before* consulting `did`, `c.env.HTML_KV`, or `c.env.USER_DO`.

**Asserted by.** Extension to `test/lazy-html.ts`.

**Invariants.**

1. `shouldSkipLazyHtml({ dev: true })` SHALL return `true`.
2. `shouldSkipLazyHtml({ dev: false })` SHALL return `false`.
3. The function SHALL be a pure expression of its argument — no
   reads from `import.meta`, `process`, or other ambient state. The
   ambient signal lives at the call site so the predicate can be
   tested in isolation.

**Failure modes the contract catches.**

- A future refactor inverts the gate (e.g. `return !args.dev`),
  re-introducing the FOUC in dev. (Invariant 1.)
- A future refactor removes the gate entirely. (Invariants 1 and 2
  jointly: the function would not exist.)
- A future refactor reads `import.meta.env.DEV` from inside the
  predicate, breaking the test harness. (Invariant 3.)

**Failure modes the contract does NOT catch.**

- The catch-all handler does not actually call the predicate (the
  function exists but is unreferenced). The dev-gating call site is
  in `src/server/index.ts:1467-1487`; verifying the call requires
  either a worker-level integration test or the manual quickstart
  step. The unit test only locks the predicate's behavior, not its
  use.
- The production code path is altered. Out of scope for this guard;
  spec SC-005 / FR-006 are covered by the manual quickstart step E.

## Contract 2: No variable-form dynamic imports under `src/server/`

**Subject.** Every `await import(...)` and `import(...)` expression
in source files under `src/server/`.

**Asserted by.** A new test, `test/server-import-shape.ts`, that
greps the source tree for `import(<expr>)` and asserts `<expr>` is
either:

- a string literal (`'./blurhash-runtime.js'`,
  `"@scope/pkg"`), or
- a template literal whose only interpolations are literal-typed
  arguments at the static-analysis layer (e.g. `\`${literal}\``).

Any identifier-only argument (e.g. `import(blurhashRuntimeModule)`)
fails the assertion.

**Invariants.**

1. No file under `src/server/` SHALL contain an `import(<ident>)`
   expression where `<ident>` is a bare identifier.
2. The fix at `src/server/index.ts:1493` SHALL be the literal form
   `await import('./blurhash-runtime.js')`.

**Failure modes the contract catches.**

- A future refactor (e.g. extracting the path into a constant for
  reuse) re-introduces the un-analyzable form.
- A new dynamic import elsewhere under `src/server/` is added with
  a variable argument. The Vite warning would re-appear in the
  terminal; this test catches it before merge.

**Failure modes the contract does NOT catch.**

- Variable-form dynamic imports under `src/client/` or `test/`. The
  warning's blast radius is the worker bundle (Cloudflare runtime),
  so we constrain the assertion to `src/server/` deliberately. If a
  client-side warning emerges, the assertion can be widened.
- Imports written as `import(\`./${someVar}.js\`)` — the linter
  cannot easily distinguish "literal interpolation" from "runtime
  interpolation." The assertion's grep is conservative and will
  flag any `${...}` interpolation as suspicious; if a legitimate
  literal-only template emerges, the test can carve it out
  explicitly.

## Out-of-scope contracts

Not introduced by this feature:

- HTML shell contract (covered by feature 015).
- Lazy-HTML cache key contract (covered by feature 015 — `html:v2:`
  prefix is unchanged here).
- DO sync contract (no change).
- Auth / session contract (no change).
