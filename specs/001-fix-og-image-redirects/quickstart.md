# Quickstart: Verify Fix for OG-Image Redirect Errors

This recipe lets a developer reproduce the original bug, confirm the fix
in this branch eliminates it, and re-run the relevant tests.

## Prerequisites

- Node 22.x (per `package.json` engines).
- Repo installed: `npm install`.
- Branch: `001-fix-og-image-redirects`.

## 1. Reproduce on `main` (optional sanity check)

```bash
git stash --include-untracked      # if you have local edits
git switch main
npm start
# In the UI: subscribe to a feed whose recent items use multi-hop
# article redirects (e.g. a syndicated/wrapped link, or any blog with
# both http→https and apex→www).
# Click "refresh feeds".
# Expected on main: server log contains:
#   "Error fetching og image for https://…: FeedFetchError: Feed
#    redirected too many times"
git switch 001-fix-og-image-redirects
git stash pop                      # if you stashed
```

## 2. Verify on this branch

```bash
npm start
# Same subscription, same "refresh feeds" click.
# Expected after fix:
#   - No "Error fetching og image" lines in the server log.
#   - No "Feed redirected too many times" lines for article URLs.
#   - The new items appear in the reader's list.
#   - Items whose article URLs resolve within 5 hops show a thumbnail.
#   - Items whose article URLs hit a genuine loop still appear, with a
#     missing thumbnail (or feed-supplied fallback image).
```

## 3. Verify a feed-XML failure is still loud (FR-005)

```bash
# Subscribe to a feed whose XML URL itself loops forever (e.g. a feed
# server with bad redirect config). After "refresh feeds":
# Expected:
#   - The feed row's last_error / last_status surface in the UI.
#   - The server logs ONE feed-level error line:
#       "Error fetching feed <feed_url>: FeedFetchError: Feed
#        redirected too many times"
#   - Other feeds in the same refresh are unaffected.
```

## 4. Run the unit tests touching this path

```bash
# Redirect-budget unit tests for both fetchers:
npm run test:feed

# Feed-parser tests including the OG-image happy and quiet paths:
node -r esbuild-register test/feed-parser.ts   # OR existing runner
# (see test/run-all-tests.mjs for the canonical invocation)

# Type-check the worker:
npm run typecheck
```

## 5. Smoke test: a single article URL in a redirect loop

```bash
# In the UI, add a feed whose latest item links to an URL that
# returns 302 to itself.
# After "refresh feeds":
# Expected:
#   - The refresh completes within ~OG_IMAGE_FETCH_BUDGET_MS (10s)
#     of when it would have completed without that item.
#   - Other items in the same refresh got their thumbnails.
#   - The server log is clean.
```

## What "success" looks like (mapped to spec)

| Spec ID   | How this quickstart proves it                           |
|-----------|---------------------------------------------------------|
| SC-001    | Step 2: zero "redirected too many times" log lines for  |
|           | article fetches.                                        |
| SC-002    | Step 2: items with multi-hop article URLs now show a    |
|           | thumbnail (previously did not on `main`).               |
| SC-003    | Step 5: single-loop item does not block other items'    |
|           | enrichment or extend total refresh time.                |
| SC-004    | Step 3: feed-XML failures still surface in the UI       |
|           | against the feed row.                                   |
