# Quickstart: Verify the Dev FOUC Fix

This is the manual verification companion to the unit-test guards in
`test/lazy-html.ts` and `test/server-import-shape.ts`. Run it before
merging anything that touches `src/server/index.ts` near the
catch-all asset handler (~line 1467) or the worker `queue` function
(~line 1491).

## Prerequisites

- A working local checkout of the branch.
- A Bluesky-OAuth-authenticated session in your browser at
  `http://127.0.0.1:2222`. (If you do not have one, sign in first;
  the FOUC scenario is only reproducible while authenticated, since
  the lazy-HTML pipeline is the source of the bug.)
- Browser DevTools open with Network and Performance tabs available.

## A. Verify the Vite warning is gone (SC-002)

1. Stop any running dev server.
2. Start the dev server with a clean terminal:
   ```sh
   npm start
   ```
3. Wait for the "ready" line.
4. Inspect the terminal output from start to "ready":
   - There MUST NOT be a line containing
     `dynamic import will not be moved to a separate chunk`,
     `cannot be analyzed by Vite`,
     or any equivalent diagnostic attributed to a file under
     `src/`.
5. Trigger a normal page load by visiting `http://127.0.0.1:2222/`.
6. Re-inspect the terminal: still no such warning at request time.

**Pass criterion**: zero matching warnings in (4) and (6).

## B. Verify no unstyled flash on hard reload (SC-001, SC-003)

1. With the dev server running and authenticated, open
   `http://127.0.0.1:2222/`.
2. Open DevTools → Performance tab. Click the **circular reload**
   button on the Performance tab to record a hard reload.
3. Stop the recording when the page is visibly settled (~2–3 s).
4. In the recorded frames timeline (the strip of screenshots above
   the flame chart), step through every frame from navigation start
   to first contentful paint.
5. For each frame, check:
   - No frame shows the browser's default underlined-link blue on
     a white background as the dominant visual.
   - The first frame with content shows app-styled content
     (rounded sidebar items, dark sidebar background, app
     typography, item rows with thumbnails laid out).
   - No frame shows feed items with the layout broken (no flexbox,
     no padding, no thumbnail aspect-ratio).

**Pass criterion**: every frame between navigation start and FCP is
either blank/loading or already styled. Repeat on `/login` and on
any other top-level route.

## C. Verify no wrong-route content flash (SC-004)

1. With the dev server running and authenticated, visit
   `http://127.0.0.1:2222/login`.
2. Hard-reload (Cmd+Shift+R). Observe what paints.
3. The page during loading MUST NOT show article-listing content,
   feed items, or any other unrelated route's seeded markup. The
   page MUST show either (a) a blank/loading state, or (b) the
   login UI itself.

**Pass criterion**: at no point during loading do article items
appear in `#root` while the URL bar reads `/login`.

## D. Verify the lazy chunk is still emitted (FR-005)

1. Build the project:
   ```sh
   npm run build
   ```
2. Inspect the worker output:
   ```sh
   find public -type f -name '*.js' | sort
   ```
3. There MUST be a file whose name begins with `blurhash-runtime`
   (suffixed with a content hash) outside the main worker entry
   bundle. Its presence confirms Vite cleaved the `import(...)`
   into a separate chunk.

**Pass criterion**: a `blurhash-runtime-*.js` file (or a Vite-named
chunk that obviously corresponds to it) exists in the build output.

## E. Production parity smoke test (SC-005, FR-006)

1. With the build artifacts from D in place, run a production-mode
   preview if one exists, or deploy to staging.
2. Authenticate. Hard-reload the home route.
3. Confirm that the production FOUC fix from feature 015 still
   holds: the first painted frame is styled, the seeded feed-item
   markup paints with full styling (production extracts component
   CSS into the bundled `<link>`).

**Pass criterion**: production behavior is byte-for-byte unchanged
from before this feature. The dev guard does not affect the
production code path.

## What to do if any check fails

- **A fails.** Re-grep `src/server/` for `await import(<identifier>)`
  patterns. The fix is to inline the literal at the import site, not
  to suppress the warning.
- **B or C fails.** The dev short-circuit either is not gating the
  lazy-HTML pipeline or is not running. Verify that
  `import.meta.env.DEV` is `true` in the worker by adding a
  temporary `console.log` immediately above the gate, observe in
  the dev terminal, then remove the log.
- **D fails.** Check Vite's output config for any `manualChunks`
  override that might be merging the `blurhash-runtime` chunk into
  the main worker bundle. The literal `import(...)` form alone is
  sufficient under default Vite chunking.
- **E fails.** The dev gate has leaked into the production bundle.
  Confirm `import.meta.env.DEV` is being statically replaced in the
  built worker (open `public/_worker.js/index.js` and search for the
  gate predicate — it should be unreachable / dead-code-eliminated).
