# Feature Specification: Fix Dev Server FOUC and Vite Dynamic-Import Warning

**Feature Branch**: `016-fix-dev-server-fouc`
**Created**: 2026-05-10
**Status**: Draft
**Input**: User description: "I get a warning in terminal from vite about a
dynamic import that cannot be analyzed in `src/server/index.ts` (line 882,
`await import(blurhashRuntimeModule)`). And CSS is not being served — I see
an unstyled page for a long time, then eventually the app shows up."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Local dev page load shows styled content quickly (Priority: P1)

A developer runs the local dev server and opens the app URL in the browser
(or refreshes the tab). Instead of seeing an extended period of unstyled,
default-browser-rendered content (blue underlined links on a white
background, no app chrome, no app typography, content that does not match
the destination route), the page paints with the app's styling promptly,
and the very first frame the developer sees is either blank/loading or
already styled — never the unstyled fallback shown in the bug report.

**Why this priority**: This is the developer's primary daily experience.
The current behavior — a long-lived, unstyled, wrong-looking page that
eventually swaps to the real app — makes the dev server feel broken on
every page load, undermines the recently-shipped FOUC fix (feature 015) in
the dev environment, and slows iteration because every refresh costs the
developer multiple seconds of disorienting flash. Without this fix the dev
loop is materially degraded.

**Independent Test**: With the dev server running, perform a hard reload of
the app URL (e.g. `/login`). Record the load with a screen recorder or the
browser's "performance" timeline. Inspect frames between navigation start
and first contentful paint. There must be no frame in which the page
displays unstyled content (default browser link styling, content that
visibly does not match the destination route). The total time from
navigation start to first styled paint must be within the acceptable bound
defined in the success criteria.

**Acceptance Scenarios**:

1. **Given** the dev server is running and the developer opens the app URL
   for the first time after starting the server, **When** the page loads,
   **Then** no frame displays unstyled content; the first visible content
   is styled with the app's stylesheet applied.
2. **Given** the developer is on any top-level route in the dev server,
   **When** they reload the page (Cmd+R) or hard-reload (Cmd+Shift+R),
   **Then** the first painted frame is either blank/loading or already
   styled — there is no observable unstyled flash.
3. **Given** the developer navigates directly to `/login` while
   unauthenticated, **When** the page renders, **Then** the visible content
   during loading corresponds to the destination route (the login page),
   not unrelated content from a different route or a previous session.
4. **Given** a typical local dev environment (developer machine, dev server
   already warm), **When** the page is loaded, **Then** the time from
   navigation start to first styled paint is at or below the bound defined
   in SC-001.

---

### User Story 2 - Dev server starts and runs without spurious warnings (Priority: P2)

A developer starts the local dev server. The terminal output is clean: it
does not emit warnings about dynamic imports that the bundler cannot
statically analyze, nor any other warnings introduced by the project's own
code that could be eliminated by writing the import in an analyzable form.

**Why this priority**: Spurious warnings in the dev terminal train
developers to ignore warnings, which masks future real problems. The
specific warning the user reported (an un-analyzable dynamic import in the
server entry) also blocks the bundler from understanding the module graph
that includes that path, which is likely contributing to slow or incorrect
asset serving in dev — the same root cause may underlie User Story 1.
Resolving this is therefore both hygiene and a likely contributor to the
P1 fix. P2 because the user-visible pain is the FOUC; the warning is the
upstream cause we suspect, not the surface symptom.

**Independent Test**: Start the dev server from a clean state. Capture the
terminal output from start to "ready." There must be no warning matching
"dynamic import cannot be analyzed by Vite" or any equivalent warning
attributable to the project's own source files. Trigger a normal page load
and confirm no such warning is emitted during request handling either.

**Acceptance Scenarios**:

1. **Given** the dev server is started fresh, **When** it reaches its ready
   state, **Then** the terminal output contains no warning about an
   un-analyzable dynamic import originating from project source files.
2. **Given** the dev server is running, **When** the developer loads a page
   that exercises code paths involving the previously-warned import,
   **Then** no warning is emitted to the terminal at request time.
3. **Given** the project still needs to lazily load the runtime referenced
   by the warned-on import (or any equivalent runtime), **When** that lazy
   load is exercised, **Then** it still works correctly — the warning is
   eliminated by making the import analyzable, not by removing the lazy
   loading capability.

---

### Edge Cases

- **Cold dev server (just started)**: First page load after `vite dev`
  starts may incur a one-time compilation cost. The fix is not required to
  eliminate that cost entirely, but the visible behavior MUST still be no
  unstyled flash — if the page is not ready, show blank/loading, not
  unstyled wrong-content.
- **Stale/cached HTML in the browser**: If the browser has cached an HTML
  response from a previous dev session (e.g. before the fix was deployed),
  the fix MUST NOT make that case worse. Once the cache is invalidated by
  a normal reload, the fixed behavior MUST take effect.
- **Wrong-route content during flash**: The reported symptom shows article
  content while the URL bar reads `/login`. The fix MUST ensure that any
  HTML rendered before client-side routing settles is consistent with the
  destination route, OR is replaced by a neutral loading state, so the
  developer never sees content that contradicts the URL.
- **Slow network or CPU**: Under reasonable throttling (slow disk, CPU
  contention from other dev processes), the FOUC-free guarantee MUST still
  hold — content that appears MUST be styled, even if the total time to
  first paint is longer.
- **Production parity with feature 015**: The fix MUST NOT regress the
  production FOUC fix delivered in feature 015. If the same root cause
  affects production, fixing it in dev should not break production; if the
  fix is dev-only, it MUST be confined to the dev pipeline.
- **Other lazy-loaded runtimes**: If the codebase contains other dynamic
  imports following the same un-analyzable pattern as the one the user
  reported, they MUST be considered in scope for the same hygiene fix, not
  carved out.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The local dev server MUST serve every top-level route such
  that the first visible content presented to the developer is styled with
  the app's stylesheet, with no observable interval where browser-default
  styles are visible.
- **FR-002**: The local dev server MUST NOT display content that
  contradicts the destination route during loading. If the destination is
  `/login`, the developer MUST NOT see article-listing content (or any
  other unrelated route's content) before the login page appears.
- **FR-003**: Time from navigation start to first styled paint on a typical
  local dev machine (with the dev server already warm) MUST be within the
  bound defined in SC-001.
- **FR-004**: The dev server MUST start and serve normal page loads without
  emitting warnings about un-analyzable dynamic imports originating from
  project source files.
- **FR-005**: Fixing the un-analyzable dynamic import MUST preserve the
  lazy-load semantics it was implementing. The runtime that was previously
  loaded on demand MUST continue to be loaded only when needed (i.e.,
  refactoring MUST NOT eagerly bundle a heavy runtime that was being
  deferred for a reason).
- **FR-006**: The fix MUST NOT regress the production FOUC fix delivered
  in feature 015. If a single root cause underlies both the dev FOUC and
  the production behavior, the fix MUST address it without weakening the
  production guarantee.
- **FR-007**: The fix MUST NOT introduce a visible layout shift between
  the initial styled paint and the fully-loaded state.
- **FR-008**: If other dynamic imports in the codebase exhibit the same
  un-analyzable pattern, they MUST be either fixed alongside or
  explicitly noted as out of scope with rationale; silently leaving
  matching cases unfixed is not acceptable.
- **FR-009**: The fix SHOULD include a guard that catches a regression of
  the dev FOUC — for example, an automated check, a documented manual
  verification step in the dev workflow, or a recorded baseline that
  fails when a dev page load once again paints unstyled content.

### Key Entities

Not applicable — this is a dev-server / bundler / asset-loading concern,
not a data modeling change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a typical developer machine with the dev server warm,
  100% of page loads of any top-level route reach first styled paint
  within 1.5 seconds, with no frame in that interval showing unstyled
  content.
- **SC-002**: 0 warnings about un-analyzable dynamic imports originating
  from project source files appear in the dev server terminal output
  during startup or during normal page loads.
- **SC-003**: The visible unstyled-content interval during any dev page
  load is 0 ms — the developer never sees a frame with browser-default
  styling. Equivalently, no screen-recording frame between navigation
  start and first contentful paint shows unstyled content.
- **SC-004**: The wrong-route content flash described in the bug report
  (article content while the URL is `/login`) does not occur on any dev
  page load after the fix.
- **SC-005**: The production FOUC behavior delivered in feature 015 is
  unchanged by the fix — every measurable outcome from feature 015 still
  holds.

## Assumptions

- The two reported symptoms (FOUC + Vite dynamic-import warning) MAY share
  a single root cause (the un-analyzable import preventing Vite from fully
  understanding the module graph and therefore mis-ordering or delaying
  asset delivery), but they MAY be independent. Determining which is part
  of planning, not part of this specification. The spec requires both to
  be resolved either way.
- The reported FOUC is in the local dev environment specifically (Vite
  dev server with Wrangler dev, accessed at `127.0.0.1:2222`). The
  production environment is covered by feature 015 and is in scope here
  only insofar as the fix MUST NOT regress it.
- The user-reported symptom — extended unstyled content followed by a
  jump to the real styled app, including content that does not match the
  destination route — is the exact symptom to eliminate. There is no
  separate "partial styling" or "occasional FOUC" state to consider.
- Supported browsers and platforms are unchanged from the rest of the
  app; no platform-specific carve-outs for this fix.
- Existing lint, test, and CI workflows remain authoritative; the fix
  will be delivered alongside any guards that protect against regression.
- The lazy-loading intent of the original `await import(...)` call (in
  `src/server/index.ts` near line 882) is legitimate — the runtime being
  imported is only needed in the queue-handler path and should remain
  excluded from the synchronous server entry. The fix is to make the
  import analyzable, not to remove the lazy load.
