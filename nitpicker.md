# The Nitpicker's Production Readiness Review — RSSS

**Repo**: `/Users/nick/code/rsss`
**Branch**: `staging`
**Date**: 2026-04-25
**Verdict**: **Not production ready.** Multiple P0 ship-blockers in security and admin auth. The feature work is interesting; the blast-radius around it is wide open. Fix the P0s before anyone real touches this.

Recent commit messages (`add docs`, `wip`, `implement`, `add some notes`) are uniformly useless and undermine the ability to bisect or audit. Future-you will hate present-you. That's a P3 by itself, but it's also a tell about discipline.

---

## P0 — Ship-blockers

### 1. Admin endpoints have **no authentication whatsoever** [FIXED]
**File**: `src/server/index.ts`
**Lines**: 894–908 (`/admin/users`), 915–976 (`/admin/refresh-all`)

Both routes are public. `GET /admin/users` returns the DID and Bluesky handle of every user who has ever logged in — a complete user enumeration of your platform — to anyone with a browser. `POST /admin/refresh-all` lets any unauthenticated caller force a feed refresh of every user (or any specific user by DID, since DIDs are now also published). This is a denial-of-amplification / privacy disaster waiting for a curl command.

**Fix**: Gate both behind a separate `ADMIN_TOKEN` secret checked from a header, or at minimum require `requireAuth` plus an allowlist of admin DIDs. Right now the comment "Admin: list all tracked users" is the only thing standing between you and the front page of HN.

* [x] complete

### 2. `sanitizeHtml` is a regex toy and is used to render untrusted feed content into the DOM [FIXED]
**File**: `src/client/util.ts:24–31`, used in `src/client/routes/item-reader.ts:130–136`

```js
return html
  .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
  .replace(/\s*on\w+="[^"]*"/gi, '')
  .replace(/\s*on\w+='[^']*'/gi, '')
  .replace(/javascript:/gi, '')
```

Used to feed `dangerouslySetInnerHTML` with arbitrary RSS/Atom item content. The bypasses are trivial:

- Unquoted handlers: `<img src=x onerror=alert(1)>` — regex requires `="..."` or `='...'`, plain `=alert(1)` matches neither.
- Whitespace-laden handlers: `<img src=x\nonerror\t=\t"x">` — `\s*on\w+=` only matches when `=` directly follows the attribute name.
- `<iframe>`, `<object>`, `<embed>`, `<form action="javascript:...">`, `<style>` injecting `expression()` (older browsers), `<svg>` with `<script>` parsed via `xlink:href`, MathML script gadgets — none stripped.
- `<a href="java&#x09;script:foo">` — entity-encoded characters in the protocol slip past the literal `javascript:` regex; browsers still resolve it.
- `<meta http-equiv="refresh" content="0;url=javascript:...">`.
- The `<script>` regex pattern uses `\b[^<]*(?:(?!<\/script>)<[^<]*)*` which fails on `<script >` or `<scriptsrc=` (no break char).

**Why it matters**: A malicious RSS feed = stored XSS = session-cookie theft (httpOnly, but the cookie payload is the OAuth access/refresh token in plaintext, base64 in the cookie body — see issue #3 — and an attacker doesn't need the cookie if they can `fetch('/api/...')` from the origin). DOM-based XSS will also let them push outbox writes, mark all items read, or pivot to whatever you build next.

**Fix**: Use a real sanitizer. `DOMPurify` is a drop-in. If you want to keep things small, render `textContent` only. Do not roll your own HTML sanitizer — this rule is older than Node.js.

* [x] complete

### 3. Session cookie payload includes plaintext OAuth tokens; "encrypted-cookie sessions" claim is wrong [FIXED]
**File**: `src/server/auth/oauth.ts:593–619`

`createSessionCookie` does HMAC-sign `JSON.stringify(session)` and concatenates `btoa(payload).signature`. That is **signed**, not **encrypted**. The cookie body is base64 plaintext containing `accessToken`, `refreshToken`, `expiresAt`. Anyone who steals or logs the cookie has the user's Bluesky access token, *and* anyone with browser-extension access to cookies (which httpOnly does not protect against — extensions with `cookies` permission read httpOnly cookies happily) gets the same.

Worse: this cookie has no expiry semantics inside the payload — `verifySessionCookie` never checks `expiresAt`. A 30-day cookie outlives the OAuth access token by weeks; the token ends up dead but the session is still "valid".

**Fixes** (in priority order):
1. Stop putting tokens in the cookie. Store the session record in KV under a random session id; the cookie carries only the id.
2. Verify `expiresAt` server-side in `verifySessionCookie`.
3. If you keep encrypting cookie payloads, use AES-GCM via `crypto.subtle`, not HMAC-only. The README claims encryption; deliver it or stop saying it.
4. Implement actual logout: KV deletion, not just `deleteCookie`.

* [x] complete

### 4. DPoP key pair is generated, used once for the token exchange, then **thrown away** [FIXED]
**File**: `src/server/auth/oauth.ts:417, 511–516`. Also `fetchWithDPoP` (lines 531–581) is dead code.

`exchangeCode` returns the `dpopKeyPair` to the caller (`src/server/index.ts:377` does `await exchangeCode(...)`) but the result is bound to `session` and then `dpopKeyPair` is discarded — only `did, handle, accessToken, refreshToken, expiresAt` are stored in the session cookie. DPoP-bound tokens **cannot be used without the corresponding key pair** on every subsequent request. Bluesky's PDS will reject any future API call you try to make with that access token.

Either:
- You're never actually calling the AT Protocol after login (which appears to be the case — `fetchWithDPoP` has zero callers), in which case the OAuth flow is theatre and you should at least delete the unused code and the `accessToken`/`refreshToken` from the session.
- Or you intend to call the PDS later, in which case you need to persist the DPoP key pair (encrypted, with the access token, in KV under the session id) and rebuild it on each request.

Right now you're paying the complexity tax of DPoP for nothing.

**Resolution**: Took the first option — OAuth is used purely as a login mechanism for Bluesky identity (DID + handle); the app never calls the user's PDS. Removed `accessToken`/`refreshToken`/`expiresAt` from `OAuthSession`, simplified `exchangeCode` to return only `{ did, handle }`, and deleted the unused `fetchWithDPoP` function. The DPoP key pair is still generated for the PAR + token exchange (Bluesky requires it) but is now intentionally discarded after the exchange, with a comment explaining the design choice.

* [x] complete

### 5. SSRF: server-side feed fetch lets users issue arbitrary outbound requests with no scheme/host validation
**File**: `src/server/durable-objects/index.ts:622–626` (`fetchFeed`), reachable from `POST /feeds` (line 130) and `POST /feeds/:id/refresh` (line 295).

`fetch(feed.url, ...)` with whatever the user posted. On Cloudflare Workers, RFC1918 isn't reachable, so the classic AWS-metadata SSRF doesn't apply, but:
- `file://`, `http://localhost`, etc. — Workers `fetch` does block some of these, but you should not rely on undocumented platform behaviour.
- Workers can hit other internal services on the same Cloudflare account if you ever add a private worker route or a service binding.
- More immediately: this is an **unbounded fetch with no size limit, no timeout** (`response.text()` will pull a 1 GB feed into memory, then a backtracking regex parser will choke on it — see #20).
- And: the URL is never validated as `http(s):` or as a syntactic URL. `fetch('javascript:alert(1)')` doesn't actually do anything useful, but `fetch('chrome://...')` and the like clutter logs.

**Fix**: Validate `new URL(url).protocol` is in `{http:, https:}`, reject obvious local hosts (`localhost`, `127.*`, `0.0.0.0`, `::1`, `[::]`, anything in `.local`), set a `signal: AbortSignal.timeout(15_000)`, and cap the body size with a streamed reader.

* [ ] complete

### 6. Multi-tab OPFS: the SAH pool VFS is exclusive; second tab silently breaks
**File**: `src/client/db/sqlite-init.ts:85–101`

`installOpfsSAHPoolVfs({ directory: 'rsss-db' })` acquires `FileSystemSyncAccessHandle`s, which are exclusive per-file. If a user has two tabs open (and they will), the second tab's `openLocalDb` will hang or throw, the first tab keeps the lock, and the bootstrap progress UI on the second tab will spin forever (or worse, mark the bootstrap "failed" and `removeOpfsDb` the file out from under the working tab).

There is no detection, no `BroadcastChannel` coordination, no leader election, no UI surfacing of "another tab is using this database." The current behavior is that the second tab silently falls back to the remote adapter — except it doesn't, because the path that throws is wrapped in a generic catch only for `OPFSUnavailableError`.

**Fix**: Either (a) coordinate tabs via `BroadcastChannel` + a Web Lock, with one tab as primary and others reading via postMessage, or (b) detect the lock failure explicitly, surface "open in another tab" as an error state, and fall back to remote-adapter for the second tab. Pick one and document it.

* [ ] complete

---

## P1 — Fix soon

### 7. `requireEntitlement` runs on `/api/*` after `requireAuth`, but `/api/auth/*` and `/api/billing/*` are also under `/api/*`
**File**: `src/server/index.ts:860–889`

Hono routes are matched in order. The earlier specific routes (`/api/auth/login`, `/api/billing/checkout`, etc.) match first, so they bypass `requireEntitlement`. That's actually intended. But the catch-all `app.all('/api/*', requireAuth, requireEntitlement, ...)` also runs `requireAuth` — meaning it requires a session but auth routes don't have `requireAuth` configured. Fine for now, but the layering is fragile: any future `app.get('/api/foo', handler)` inserted *after* the catch-all will be unreachable, and one inserted *before* won't get auth/entitlement checks. Add an explicit comment, or — better — refactor entitlement-gated routes onto a sub-router (`app.route('/api/data', dataRouter)`).

* [ ] complete

### 8. Push-then-pull ordering loses optimistic local writes on conflict
**File**: `src/client/state.ts:262–286`

The flow is: `pullSync` → then `pushSync`. If a user marked an item read locally (which writes to local DB *and* enqueues an outbox row), then opens the app:
1. `pullSync` upserts the server's view of the item (`is_read = 0`) over the local `is_read = 1`.
2. `pushSync` then attempts to push the outbox row, but the local DB now lies about the user's intent in its `items` table — only the outbox row preserves it. If push fails with 409 the resolution copies server state again. If push succeeds, server now has `is_read = 1` but the local item row is `is_read = 0` until the *next* pull picks up the round-trip.

**Fix**: pushSync should run *before* pullSync, OR pullSync should skip rows that are referenced by pending outbox entries, OR conflict resolution on 409 should re-apply outbox semantics on top of the server row.

* [ ] complete

### 9. Optimistic local feed insert never reconciles its primary key with the server's
**File**: `src/client/db/local-adapter.ts:91–114`, `src/client/db/push-sync.ts:235–266`

`addFeed` inserts a feed locally with a client-side autoincrement id (e.g. `1`), pushes via outbox. The server returns the feed with its own id (e.g. `42`). The push-sync 2xx success path just deletes the outbox row — the local row keeps id `1`, and the next pull-sync upserts the server row with id `42`. You now have two rows for the same URL. The UNIQUE(url) constraint prevents a second insert from the server, so the upsert path with `ON CONFLICT(id)` *only* matches on id, leaving the optimistic local-id orphan plus a fresh server-id row. The user sees duplicates.

**Fix**: On 2xx for `add_feed`, parse the server's response `{ feed }`, delete the optimistic local row, and upsert the canonical server row. Same problem applies to any future "insert" outbox operation.

* [ ] complete

### 10. SQLite foreign keys are off by default; ON DELETE CASCADE is a lie
**File**: `src/shared/schema.ts:37`

`FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE` is declared but never enforced. SQLite (both wa-sqlite and Cloudflare DO SQL) requires `PRAGMA foreign_keys = ON;` per connection. Neither initDatabase (server) nor openLocalDb (client) sets this. Result: deleting a feed in the local-adapter explicitly does `DELETE FROM items WHERE feed_id = ?` (line 121) — fine, you compensated. But the schema *says* CASCADE. When this is forgotten in the next refactor, items will be orphaned. And on the server, `DELETE FROM feeds WHERE id = ?` (line 290) does **not** delete child items — they stay forever, taking up DO SQLite quota.

**Fix**: `PRAGMA foreign_keys = ON;` after opening the DB. Or remove the FK clause and own the cascade explicitly.

* [ ] complete

### 11. Outbox has no attempt cap; a poison row is permanent
**File**: `src/client/db/push-sync.ts:58–69, 269–273`

`incrementAttempt` keeps growing forever. A row that always 5xxs (e.g. server bug, malformed payload from a client-version mismatch) will be retried on every sync forever, surface as a permanent "Sync error" badge, and the user has no recourse. The "Reset local data" button will best-effort-pushSync it again, fail, and then wipe it — so the only escape is a destructive reset.

**Fix**: cap attempts at e.g. 10, then move the row to a `dead_letter_outbox` table or surface it in the UI for manual resolution.

* [ ] complete

### 12. Feed parser regex backtracks on adversarial input; no size limit on response body
**File**: `src/server/durable-objects/index.ts:621–690`, `parseRss`/`parseAtom` lines 718–813

- No `Content-Length` check, no max body size, `await response.text()` will buffer everything.
- Regex patterns like `<entry>([\s\S]*?)<\/entry>` and the CDATA matcher `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>` are catastrophic backtracking candidates on truncated or malicious feeds. Worker CPU time is finite (10ms-50ms on free, 30s on paid), and one user with one bad feed can wedge their DO's alarm and burn budget.
- Tag matching by regex is wrong on principle. `<title>` inside a `<channel>` and `<title>` inside a `<media:title>` are conflated.
- `getTagContent` ignores namespacing (`dc:creator` works only because it happens to be a literal substring).

**Fix**: Use a streaming parser (`htmlparser2`/`fast-xml-parser`/etc.) bundled or accept the surface area and add: 5MB body cap, a 15s overall timeout, and a per-feed CPU budget.

* [ ] complete

### 13. `await this.fetchFeed(feed)` in `POST /feeds` blocks the response
**File**: `src/server/durable-objects/index.ts:196`

User adds a feed → server tries to fetch and parse the feed → user waits up to 30s → response. On Cloudflare Workers this is a CPU/time hazard *and* a UX problem. A slow third-party feed makes the request hang.

**Fix**: Insert the feed, return 201 immediately, fire-and-forget the initial fetch via `ctx.waitUntil(this.fetchFeed(feed))`. Client polls or sees the items appear on the next sync.

* [ ] complete

### 14. Admin route `/admin/refresh-all` calls `Promise.all` over up to N user DOs; alarm `fetch` floods over per-DO feeds
**File**: `src/server/index.ts:943–973`, `src/server/durable-objects/index.ts:847–854`

The admin route iterates serially, which is fine. But `alarm()` does `Promise.all(feeds.map(feed => this.fetchFeed(feed)))` — for a user with 200 feeds that's 200 concurrent outbound `fetch`es from a single DO. CF Workers have a soft limit of 1000 subrequests per request, but more practically: this will trigger upstream rate limiting, exceed the per-DO CPU budget, and (since `fetchFeed` swallows errors silently) you have no observability into which feeds failed.

**Fix**: Bounded concurrency (e.g. p-limit with concurrency 8), record per-feed last_error / last_status into the feeds table.

* [ ] complete

### 15. `alarm()` does not await the rescheduling call
**File**: `src/server/durable-objects/index.ts:853`

```ts
this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000)
```

Returns a promise; not awaited. If the DO is evicted between the last `await` and function return, the alarm may not be persisted. Async is async, even when it looks fire-and-forget.

**Fix**: `await this.ctx.storage.setAlarm(...)`.

* [ ] complete

### 16. `cors()` open to all origins on `/api/*` while authentication is cookie-based
**File**: `src/server/index.ts:194`

`cors()` with no config enables `Access-Control-Allow-Origin: *`. With cookie auth, this is mostly safe because browsers refuse to send cookies cross-origin without `credentials: 'include'` *and* a specific Origin echo (not `*`). But:
- It implies a misunderstanding of the auth model and will bite when someone adds `credentials: true` "to enable some integration."
- It exposes API responses to scraping by any origin (e.g. `fetch` from a sandbox iframe of an attacker page can read `/api/me` if cookies were attached — they aren't, but the next person to read this code may not know that).
- CSRF: `SameSite=Lax` covers top-level navigations but not all subresource POST patterns. Add an explicit CSRF token, or move to `SameSite=Strict`, or check `Origin`/`Sec-Fetch-Site` on state-changing routes.

**Fix**: Either drop CORS entirely (you only call from same-origin) or restrict to your origin and add CSRF protection on POST/PATCH/DELETE.

* [ ] complete

### 17. `withIsolationHeaders` blocks third-party iframes already embedded in the app
**File**: `src/server/isolation-headers.ts`, used in `src/server/index.ts:188–191`. Iframes in `src/client/components/header.ts:85–91, 132–139` and `src/client/index.ts:60–63`.

You set COEP `require-corp` to enable `FileSystemSyncAccessHandle`. Then you embed `https://github.com/sponsors/nichoth/button` and `.../card` iframes — those will not load because GitHub doesn't send `Cross-Origin-Resource-Policy` / `Cross-Origin-Embedder-Policy: credentialless` headers. The browser will silently block them.

Two ways out:
1. Switch to `Cross-Origin-Embedder-Policy: credentialless` (mostly equivalent for OPFS-SAH purposes, supported in Chromium and recent Safari/Firefox) — third-party resources without CORS load but with no credentials.
2. Drop the iframes and use a static "Sponsor" button link.

This is also a P0-adjacent footgun: the local-first feature *requires* `crossOriginIsolated`, so the headers can't simply be removed. Solve the iframe problem properly.

* [ ] complete

### 18. `verifySubscription` typing leaks and confidence-by-cast
**File**: `src/server/index.ts:170–177, 680–684`

```ts
status: verified ? (verified.status as 'active'|'scheduled') : 'none'
```

`verifyySubscription` returns `{ planId:string, status:string }` (line 121: `String(s.status)`). The cast assumes Autumn only ever returns `'active'` or `'scheduled'` because the function filters those. That's true *today*. But the cast hides the assumption — if Autumn's SDK changes the field shape or adds a third state, you'll quietly classify `'past_due'` as `'scheduled'`.

**Fix**: Make `VerifiedSubscription` typed `status: 'active'|'scheduled'`. Have `verifySubscription` do the narrowing.

* [ ] complete

### 19. `lastPullAt` timestamp format mismatch is a known footgun the code documents but does not solve
**File**: `src/server/durable-objects/index.ts:556–572`, `src/client/db/local-adapter.ts:249–250, 277, 284`

The DO comment notes the issue: SQLite `datetime('now')` produces `'2026-02-10 00:08:00'` while JS `toISOString()` produces `'2026-02-10T00:08:00.000Z'`. The space sorts before `T` in ASCII. The DO's sync endpoint normalizes its `syncedAt` to space-format, and `latestUpdatedAt` is sorted-and-popped from raw row values, so server-side it's consistent.

But: pull-sync **upserts feed/item rows from the server with whatever format they came in** (mostly space-format from DO). Then the client local-adapter mutates rows with `datetime('now')` (space-format) on update, but `addFeed` writes `new Date().toISOString()` (line 92) — ISO format. Now the local feeds table has *mixed* formats. The next pull sets `lastPullAt = data.latestUpdatedAt` (server format). String `>` comparisons across rows that were created with `toISOString()` and rows created with `datetime('now')` will be wrong: `'2026-04-25T00:00:00.000Z' > '2026-04-25 23:59:59'` is `true` ('T' > ' ').

**Fix**: Pick one format and use it everywhere. The path of least resistance is `datetime('now')` server-side and a `formatSqliteTs` helper client-side that produces matching strings. Don't mix.

* [ ] complete

### 20. No retry / no dead-letter on email sends; dedupe keyed on `(did, planId, event)` will block legitimate re-sends after recovery
**File**: `src/server/email.ts:48–123`

`sendOnce` writes the dedupe marker with a 7-day TTL. If a user goes through `payment_failed` → real fix → `subscription_started`, the second email fires (different event), fine. But: if `subscription_started` fires for the same plan on a re-subscription within 7 days (after a cancellation), the email is suppressed.

Also, on Resend transient failure, `sendOnce` throws — the caller catches and logs but never retries. A 500 from Resend means the user gets no email and no retry will come because (a) there's no dedupe marker, but (b) nothing schedules another attempt.

**Fix**: Include a coarse epoch in the dedupe key (`subscription_started:${planId}:${weekIndex}`) and queue retries on transient Resend errors.

* [ ] complete

### 21. `is_locally_cached` column is half-finished
**File**: `src/shared/schema.ts:18`, `src/server/durable-objects/index.ts:101–109, 248–267`

The column is created, migrated in, has a PATCH endpoint to toggle it, but **nothing reads it**. No client UI, no sync filter, no documentation of intent. Either commit to it and ship it, or rip it out. Half-finished schema columns rot.

* [x] complete

### 22. `getItemByRoute` matches on `LIKE %route%` and returns the first hit; cross-feed collisions return wrong item
**File**: `src/server/durable-objects/index.ts:376–416`, `src/client/db/local-adapter.ts:185–209`

If two feeds publish `/post/2026/intro` (different feed_titles, different content), the `LIKE` match returns whichever row sorts first by `pub_date DESC`. The route-to-item resolution is best-effort, but it's used to render the article body — wrong feed's content can be shown.

**Fix**: Match on exact `link`, not `LIKE %candidate%`. The client already URL-decodes the route; just compare `items.link = ?` and try a few normalized forms (with/without trailing slash, with/without `https://`) explicitly.

* [ ] complete

---

## P2 — Nice to have

### 23. README's `Deploy` section is incomplete
**File**: `README.md:124–139`

- Doesn't mention `OAUTH_CLIENT_ID`, `AUTUMN_SECRET_KEY`, `RESEND_API_KEY`, `RESEND_FROM` — all referenced in `Env`. A fresh deploy will silently lose billing and email.
- Doesn't say how to verify deploy (`/api/health`, `/oauth/client-metadata.json`).
- Doesn't say how to rotate `SESSION_SECRET` (which would invalidate every active session — see #3).
- Doesn't mention the `compatibility_flags: nodejs_compat` requirement is consequential for `autumn-js`/`resend` (these likely pull node built-ins).
- Doesn't say where to set the KV preview_id for `wrangler dev`.

* [ ] complete

### 24. Constructor runs migrations on every DO wakeup
**File**: `src/server/durable-objects/index.ts:54–67`

`PRAGMA table_info(feeds)` + conditional ALTER on every constructor. Fine for correctness, but the DO wakes thousands of times per day. Cache the "schema is current" flag in storage (`migration_v: 2`) and skip the introspection.

* [ ] complete

### 25. State.user duplicates with localStorage; localStorage is read but is not the source of truth
**File**: `src/client/state.ts:436–447`

`USER_STORAGE_KEY` is written on auth check but the only read of it is implicit (it's never read in code). It's purely a debug/diagnostic dump. If you don't use it, delete it; if you do, document that it's not authoritative.

* [ ] complete

### 26. Frontend `Feed`/`Item` interfaces are duplicated and drift
**File**: `src/client/state.ts:70–94` vs `src/client/db/types.ts:5–31`

`state.ts` defines `Feed` without `updated_at`; `db/types.ts` has it. Picking the wrong one bites at compile time only if you import from the right place. Consolidate to one source of truth and re-export.

* [ ] complete

### 27. `DEBUG` localStorage key is stomped on every page load
**File**: `src/client/index.ts:18–24`

DEV/staging always writes `'rsss,rsss:*'`, prod always removes it. Users debugging issues can't add their own DEBUG namespaces — they'll be overwritten on refresh. Use `if (!localStorage.getItem('DEBUG'))` to seed it once.

* [ ] complete

### 28. `pull-sync` reports `setSyncDone(0)` after pull, then push-sync reports `setSyncDone(pending)` — UI flickers
**File**: `src/client/db/pull-sync.ts:192`, `src/client/db/push-sync.ts:283–286`

Pull finishes, badge says "Synced 0 pending"; then push starts and immediately overwrites with whatever the post-push count is. For a user whose outbox cleared, no flicker; for everyone else, you get a visible blip. Use a single sync orchestrator.

* [ ] complete

### 29. `effect()` in `State()` will run on every signal change, including `state.user.value` toggles caused by `checkAuth`
**File**: `src/client/state.ts:252–287`

This effect runs the bootstrap-or-load logic. It re-runs whenever `isAuthenticated` flips. The body calls `getAdapter(did)` which is cached, then unconditionally fires `pullSync`/`pushSync`/`loadFeeds`/`loadItems`/`loadCounts`. There's no guard against firing twice on a single auth change (e.g. `checkAuth` → `setUser(null)` → `setUser(value)` would trigger this twice). Add a generation counter or `useRef`-style flag.

* [ ] complete

### 30. `findItemByRoute` falls back to `item.link?.includes(itemRoute)` which is the same fragile substring match as the server-side LIKE
**File**: `src/client/state.ts:1071–1089`

Same correctness issue as #22 but client-side. If `routeToItemRoute` returned `'foo.com/a'` and any item link contains that anywhere, it matches.

* [ ] complete

### 31. `addFeed` form reads `els['new-feed-url']` without a type cast; the linter doesn't object because `HTMLFormControlsCollection` indexer returns `Element | RadioNodeList`
**File**: `src/client/components/sidebar.ts:53–56`

Works at runtime; type-unsafe. `(els.namedItem('new-feed-url') as HTMLInputElement).value`.

* [ ] complete

### 32. No 401-on-pull handling
**File**: `src/client/db/pull-sync.ts:139–161`

push-sync handles 401 by throwing `PushSyncAuthError`. pull-sync just throws a generic error on non-2xx, including 401 (which means session expired). The user sees "Sync error" forever instead of a "please log in again" banner.

* [ ] complete

### 33. `getOrCreateCustomer` swallows the customer record return value
**File**: `src/server/index.ts:602–607`

`getOrCreateCustomer` returns nothing useful; `customer.email` is dropped. If you want to authoritatively read the email back, do so here instead of in `resolveContactEmail` later.

* [ ] complete

### 34. `verifySessionCookie` decodes signature using `atob` after replacing `-_` with `+/` — but `payloadB64` is decoded with raw `atob`
**File**: `src/server/auth/oauth.ts:632, 645–648`

`createSessionCookie` writes `payloadB64 = btoa(payload)` (standard base64) and `signatureB64 = base64UrlEncode(...)` (URL-safe). Verification correctly re-URL-decodes the signature. The payload is fine because `btoa` is standard and `atob` round-trips. But the asymmetry — payload is standard base64, signature is URL-safe base64 — is confusing. If the cookie ever ends up in a URL or a header that gets URL-decoded, the `+`/`/` in payload will trip it up.

**Fix**: Use URL-safe base64 for both.

* [ ] complete

### 35. No tests for OAuth, billing, email dedupe, or DO request handling
**File**: `test/`

What is tested: in-memory adapter contract, sync diff logic, LWW conflict simulation, push/pull sync round-trip with wa-sqlite, local-first settings.

What is **not** tested:
- OAuth state generation and verification (`createSessionCookie` / `verifySessionCookie`).
- DPoP proof construction (which is dead code, but still — it's complicated dead code).
- Autumn billing helpers (mock the Autumn client and test `verifySubscription`).
- Email dedupe with KV.
- The DO's HTTP handlers (you can instantiate `UserDO` in a Worker test environment via `@cloudflare/workers-types`/`workerd`).
- The HTML sanitizer (which currently passes nothing because no test calls it — see #2; an XSS test suite would have caught the regression).
- The route-to-item match logic (#22, #30).

* [ ] complete

### 36. No CI configuration in repo (no `.github/workflows/`)
The `npm test` script exists but nothing runs it on PR. The discipline of "tests must pass before merge" is purely vibes.

* [ ] complete

### 37. `addEventListener('online')` and `addEventListener('offline')` are added in `State()` and never removed
**File**: `src/client/state.ts:289–317`

* [ ] complete

State() is called once at module load (`src/client/index.ts:12`), so the leak is bounded. But if anyone introduces hot reload or test-time module re-imports, listeners stack up. A `cleanup` function paired with `State()` would be safer.

* [ ] complete

### 38. `Header` component's iframes have no `loading="lazy"`, no `sandbox`, no `referrerpolicy`
**File**: `src/client/components/header.ts:85–91, 132–139`

Even ignoring the COEP block (#17), embedding GitHub's iframe without `sandbox="allow-scripts"` (or stricter) gives it full access to the parent referer string and similar.

* [ ] complete

### 39. `disableLocalFirst` and `resetLocalFirst` swallow `pushSync` errors as `// best-effort`
**File**: `src/client/db/index.ts:128–168`

Comment literally says "best-effort — ignore errors". Translation: the user just clicked "delete my local data" and you may have just discarded their unsynced reads/stars. The Settings UI does warn via `confirm()` for the disable path (line 99–102 of `settings.ts`), but `resetLocalFirst` (the "Reset local data" button) does the same swallow — line 117-118 says "will be synced before wiping" which is a *promise*, not best-effort. Mismatch between what the UI says and what the code does.

**Fix**: Either honor the promise (await pushSync without swallow, abort the reset on error and surface it) or change the UI text to "we'll try to sync first, but unsynced changes may be lost."

* [ ] complete

### 40. `Items` rendering has no virtualization; 1000-item lists will jank
**File**: `src/client/routes/feed-reader.ts:131–143`

Fine for a 20-item page. But pageSize maxes at 100 and the items list is rendered inline without `key=${item.id}` *outside* the wrapping `<li>` (it's on the `<li>` — that's fine actually). Just flagging that there's no virtualization headroom; not a current issue.

---

## P3 — Nits

### 41. Commit messages are all garbage
`add docs`, `wip`, `implement`, `add some notes` — this is what a junior writes their first week. You're clearly capable of writing prose (see the inline JSDoc), so apply 10% of that to commit messages. I am not going to bisect anything in this repo because there is no signal to find.

* [ ] complete

### 42. Inconsistent style — most TS uses 4-space indent + no space before `:` in types (per CLAUDE.md), but plenty of files use the spaced style (`id: number` instead of `id:number`)
Both `src/server/durable-objects/index.ts` and `src/server/auth/oauth.ts` use spaced-colon style. `state.ts` and most client code uses no-space style. Pick one and lint for it.

* [ ] complete

### 43. Dead code
- `getAttr` is commented out in `parseRss` (lines 730–734).
- `fetchWithDPoP` and `generateSessionToken` are exported and unused.
- `_state` parameters in `loadBillingStatus`, `signalCheckoutFailed`, `openCustomerPortal` (`state.ts`).

* [ ] complete

### 44. `cors()` on the Hono router inside the DO is pointless
**File**: `src/server/durable-objects/index.ts:114`. The DO is only invoked via `stub.fetch` — there's no browser making a CORS preflight against `http://do/`. Remove.

* [ ] complete

### 45. `app.get('/health', ...)` and `app.get('/api/health', ...)` both exist
**File**: `src/server/index.ts:216–222`. Pick one.

* [ ] complete

### 46. `routeToItemRoute` and `findItemByRoute` are exported from `state.ts` but really belong in a `routing.ts` helper module
The mix of state functions and pure helpers in one 1000-line file is a maintainability tax. Splitting it would also make the duplicated `Feed`/`Item` types easier to reconcile (#26).

* [ ] complete

### 47. `parseInt` calls without radix
**File**: `src/server/durable-objects/index.ts:237, 249, 271, 296, 321, 322, 330, 354`. Almost every one is `parseInt(c.req.param('id'))` — radix defaulted, fine for decimal-only inputs but an ESLint rule disagrees and so do I.

* [ ] complete

### 48. README's "Deploy" claims `wrangler kv:namespace create SESSIONS` — the modern command is `wrangler kv namespace create SESSIONS` (no colon)
The colon form is deprecated. Rote-following the README will print a deprecation warning at minimum.

* [ ] complete

### 49. `text:` field in emails contains `'/settings'` as a relative URL
**File**: `src/server/email.ts:148, 161` (`<a href="/settings">`). In an email client, that resolves to the user's mail provider, not your app. Use absolute URLs from `baseUrl`.

* [ ] complete

### 50. `state._setRoute('/')` is called from inside an `effect` body in `State.handleOAuthCallback` which is called from inside a route handler in `routes/index.ts:59`
The control flow — render the route handler → side-effect a network call → conditionally re-route — is opaque. A reader has to trace through three modules. A short comment in `routes/index.ts:47–61` would help; you have one, but it doesn't mention that `handleOAuthCallback` is async and may bounce the route after rendering `LoginPage` once.

* [ ] complete

---

## Categories with no findings

- **DO transactions / hibernation correctness**: The DO uses synchronous SQL (which CF DO SqlStorage exposes) and `blockConcurrencyWhile` only in the constructor (correct usage). Transactions inside request handlers don't span async boundaries because the handlers don't use BEGIN/COMMIT — single statements are atomic. The local-adapter wraps multi-statement operations in BEGIN/COMMIT, which is correct.
- **SQL injection**: All `sql.exec` calls in both DO and local-adapter use `?` placeholders. The dynamic `WHERE` builders concatenate placeholders, never values. Clean.
- **Frontend signals discipline**: Sequential signal writes are correctly wrapped in `batch()` everywhere I checked (state.ts, billing-status.ts, sync-status.ts, local-first-settings.ts, bootstrap.ts). The CLAUDE.md guidance is being followed — credit where due.

---

## Closing Remarks

The architecture is interesting and the local-first wiring is done with more care than most projects manage on a first cut: outbox pattern, LWW conflict reconciliation, capability-gated fallback to remote-adapter. Where the rigor falls apart is the **boundary** — the public surface that takes input from the world. Untrusted feed content, unauthenticated admin routes, hand-rolled HTML sanitization, plaintext tokens in cookies, half-implemented DPoP. These aren't subtle bugs; they're standard issues that should never have shipped past a `staging` branch with `wip` commit messages.

The `nichoth` half of this review notes that you *clearly* know how to write thoughtful code (the LWW logic, the bootstrap state management, the billing dev/live split). Bring that same discipline to the security boundary. Fix the P0s before you point this at a real DNS name.

Specific action order I'd recommend:
1. Lock down `/admin/*` (P0 #1) — 10 minutes.
2. Replace `sanitizeHtml` with DOMPurify (P0 #2) — 30 minutes.
3. Move OAuth tokens out of the cookie (P0 #3) — 2 hours.
4. Decide what to do with DPoP (P0 #4) — either persist the keys or rip the unused machinery out.
5. Tab coordination for OPFS (P0 #6) — half a day for a `BroadcastChannel`-based leader.
6. SSRF / size limits on feed fetch (P0 #5) — an afternoon.
7. Then the P1s in roughly the order listed.

Total: about a week of focused work for one engineer to clear P0+P1. Then this is shippable.
