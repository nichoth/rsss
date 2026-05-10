# Quickstart: Fix Flash of Unstyled Content on Page Refresh

## Goal

Manually verify that refreshing every top-level route paints with the
app's stylesheet on the first visible frame, on warm cache, cold
cache, and a slow-network profile, in dev (`npm start`) and in a
production-like build (`npm run build` served by `wrangler dev` or
the deployed worker).

## Prerequisites

- `npm install` already done.
- Bluesky OAuth credentials in local `.env` per project README.
- A signed-in account with at least one subscribed feed that has
  recent items (so the lazy HTML pipeline produces a seeded shell
  rather than the empty fallback).
- Chrome / Edge / Safari / Firefox. Each one is the supported
  browser matrix per FR-006.

## Steps

### A. Dev mode (the regression site)

1. **Start the dev stack.**
   - `npm start` (Vite + wrangler dev). Visit
     `http://127.0.0.1:2222/`.
   - Sign in.

2. **Warm-cache reload baseline.**
   - Press Cmd+R / F5.
   - **Expected:** the first frame painted shows the app's
     typography, background colour, sidebar shell (or skeleton),
     and item-row layout. There SHALL be no observable interval
     where article titles render as default-blue underlined links
     over a white background.
   - **Failure mode (the bug):** screenshot in the spec — blue
     underlined links, no app chrome.

3. **Cold-cache reload (DevTools).**
   - Open DevTools → Network → check "Disable cache" → reload.
   - Repeat the observation in step 2. (FR-002.)

4. **Slow-network reload (DevTools throttle).**
   - DevTools → Network → throttle to "Slow 3G" → reload.
   - **Expected:** if any frame is painted before the stylesheet
     applies, that frame SHALL be empty/blank (or a styled loading
     state), NOT the seeded feed markup with browser defaults.
     (Spec Edge Case 1.) Use the DevTools "Performance" recording
     or a screen recorder to step through frames if the FOUC is
     too brief to see by eye.

5. **Hard reload.**
   - Cmd+Shift+R / Ctrl+Shift+R.
   - Repeat step 2's observation. (FR-002, Acceptance Scenario 4.)

6. **Other top-level routes (US-2).**
   - Repeat steps 2–5 starting on `/about`, `/settings`, an item
     route (`/post/...`), and any other top-level route the SPA
     exposes. Each route MUST paint app-styled on the first frame.

### B. Production-like build

1. **Build and serve.**
   - `npm run build` to populate `public/`.
   - Either `npx wrangler dev` (with `ASSETS` bound) or push to a
     preview environment.

2. **Repeat steps A.2–A.6 against the built site.** All four
   (warm/cold/slow/hard) and all top-level routes.

3. **Confirm the cached path.** Open the same route twice in quick
   succession. The second hit is served from `HTML_KV` under the
   `html:v2:<did>:<feed-version>` key (see
   `data-model.md`). The cached hit SHALL paint app-styled on the
   first frame too — the cached HTML carries the same `<link>`.

### C. Stylesheet-failure degraded mode (Edge Case 2)

1. With the dev or built site running, block the stylesheet's
   network response (DevTools → Network → right-click the CSS
   request → "Block request URL").
2. Reload.
3. **Expected:** the page SHALL still be readable. This is a
   degraded-mode fallback per the spec; the only requirement is
   that this fix does not make this case worse than it is today
   (Edge Case 2).

### D. Reduced-motion / prefers-color-scheme (Edge Case 4)

1. Toggle the OS-level `prefers-reduced-motion` and
   `prefers-color-scheme` settings.
2. Reload the feed view.
3. **Expected:** the first painted frame already honors the user's
   preference; there is no flash where the wrong scheme paints
   first and the correct one swaps in. (FR-001 + Edge Case 4.)

## Sanity-check expectations

- **FR-001 (no FOUC, every route).** Steps A.2–A.6 and B.2 hold
  for every top-level route.
- **FR-002 (warm + cold + 3G).** Steps A.2 / A.3 / A.4 each show
  styled first frame.
- **FR-003 (no CLS introduced).** Compare the layout of the first
  styled frame to the fully-loaded frame in DevTools' Performance
  tab. There SHALL be no measurable shift attributable to this
  change.
- **FR-004 / SC-002 (TTFCP not regressed >10%).** In DevTools'
  Lighthouse panel, run a "Performance" audit on the feed route
  before and after the fix. The TTFCP SHOULD be neutral-to-faster
  (parallel CSS fetch vs. sequential JS-then-CSS).
- **FR-005 (works for lazy HTML *and* other delivery paths).** Step
  B.3 covers the cached lazy HTML path; step A covers the
  non-cached dev path.
- **FR-006 (works on every supported browser).** Repeat steps A
  and B in Chrome / Edge / Safari / Firefox.
- **FR-007 (regression guard).** Run `npm test`. The new
  `test/shell-html.ts` SHALL pass after `npm run build`. Manually
  remove the new `<link>` line from `index.html`, rebuild, rerun
  `npm test` — the test SHALL fail. Restore the line.

## Failure-mode triage

If the FOUC is still observed after the fix:

1. **Confirm the build artifact.** `cat public/index.html` after
   `npm run build`. The `<head>` SHALL contain a
   `<link rel="stylesheet" ...>` whose href starts with
   `/assets/`. If absent, the Vite HTML pipeline is not picking up
   the new `<link>` — re-check `vite.config.js` and the placement
   of the link in `index.html`.
2. **Confirm the served HTML.** `curl -i http://127.0.0.1:2222/`
   in dev or `curl -i <prod-url>/` against the prod site. The body
   SHALL contain the stylesheet link. If absent in prod but present
   in `public/index.html`, the issue is the lazy HTML handler — the
   handler's `injectInitialFeed` SHALL NOT strip head children
   (verified by inspection of `src/server/lazy-html.ts:26-42`,
   which only injects, never removes).
3. **Confirm KV is not serving stale.** `wrangler kv:key list
   --binding=HTML_KV` and inspect any keys whose prefix is the old
   `html:` (without the `v2:` segment). Those SHALL be ignored on
   read after the cache-key bump; if a stale entry is somehow
   served, the prefix bump did not deploy.
4. **Confirm the browser is not serving from disk cache.** Hard
   reload (Cmd+Shift+R). If FOUC vanishes only on hard reload,
   the issue is asset-cache headers on the served HTML, not the
   `<link>` — out of scope for this fix.
