# Nitpicker — Server, security, and production-readiness review
**Status**: complete
**Scope**: server, security, prod-readiness (src/server, wrangler, deploy config)
**Date**: 2026-04-27

## Top 5 things to fix before launch

1. **S1 — Add server-side billing entitlement to `dataRouter`.** The paywall does not exist on the server. Without this, no one ever has to pay; the client's 402 handling is checking for a status the server never sends.
2. **S5 + S3 — Fix the deploy story for `NODE_ENV` and the dev-login fallback secret.** A fresh `wrangler deploy` ships with `NODE_ENV=development`, leaving the dev-login route hot AND falling back to the hardcoded session secret. That's an account-impersonation bypass on a default deploy.
3. **S4 — Remove `AUTUMN_SECRET_KEY` from the `vars` block of `wrangler.jsonc`.** The next person who deploys will paste the live key into a public, version-controlled file because the binding declaration tells them to.
4. **S2 — Gate the dev billing shortcut on `NODE_ENV === 'development'`, not on `!useLive(env)`.** Today, missing Autumn config silently entitles users for free in production.
5. **S16 — Paginate `/api/sync`.** The first-time bootstrap of a user with a real backlog will exceed the response-size limit and bootstrap will fail forever. The README claims pagination; the implementation doesn't.

## Status of prior P0s (from nitpicker.md, 2026-04-25)

### Prior P0 #1 — admin endpoints unauthenticated → **FIXED, with caveat**
`requireAdmin` middleware at `src/server/index.ts:593-613` gates both `/admin/users` and `/admin/refresh-all`. Closed-by-default (503 if `ADMIN_TOKEN` unset) is correct. Bearer token compared via `timingSafeEqual` (line 580-587).

Caveat: comment claims "Avoids early exit on mismatch to prevent timing leaks" but the function returns early on length mismatch (`if (a.length !== b.length) return false`). For a fixed-length token that's fine — the comment is just wrong.

### Prior P0 #2 — sanitizeHtml regex toy → **FIXED**
`src/client/util.ts:26-32` now uses `DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style','form'], FORBID_ATTR: ['style'] })`. Sibling owns call-site coverage.

### Prior P0 #3 — session cookie carries plaintext tokens → **FIXED**
`createSessionCookie` (oauth.ts:607-628) stores `{session, sessionExpiresAt, createdAt}` in KV under `session:<sid>`; cookie body is `btoa({sid}).<HMAC>`. `verifySessionCookie` (oauth.ts:634-669) checks signature **and** verifies `sessionExpiresAt < Date.now()` and deletes the KV record on expiry. Logout (`destroySessionCookie`, oauth.ts:676-696) deletes the KV record. **Correct.**

### Prior P0 #4 — DPoP key pair generated then thrown away → **FIXED**
`OAuthSession` is now `{did, handle, avatar?}` (oauth.ts:25-29); access/refresh tokens no longer stored. `fetchWithDPoP` removed. Doc comments at oauth.ts:5-8, 19-23 record the design decision. Good.

### Prior P0 #5 — SSRF / unbounded feed fetch → **FIXED but incomplete**
`src/server/feed-fetch.ts` exists. `validateFeedUrl` (line 19-37) checks scheme, rejects a hostname blocklist. `fetchFeedText` sets `AbortSignal.timeout(15_000)` (line 50). `readBoundedText` caps body at 5 MB by streamed reader. DO calls `validateFeedUrl` on add (line 194) and refresh (line 330). Tests at `test/feed-fetch-security.ts`.

The SSRF protection is **partial** — see S5/S6 below. Re-rated **Major** rather than Critical.

---

## P0 — would lose user data or be exploited in production

### S1. `/api/sync` and the entire `dataRouter` have **no billing entitlement gate**
**File**: `src/server/index.ts:1014-1056`

```ts
dataRouter.use('*', requireAuth)
dataRouter.all('*', async (c) => { /* forwarded directly to DO */ })
```

`requireAuth` only checks for a session. The product is sold as a paid local-first sync service, but **a logged-in user with no subscription can call every `/api/feeds`, `/api/items`, `/api/sync`, `/api/items/mark-all-read`, `/api/feeds/:id/refresh` route freely.** No `requireEntitlement` middleware exists in this codebase.

Worse: the **client** explicitly handles `402 Payment Required` (`pull-sync.ts:234-239` `SyncBillingError`, `push-sync.ts:360-362` `PushSyncBillingError`). The design clearly intends the server to gate. The server doesn't.

**Fix**: Add a middleware that calls `resolveBilling(c.env, session.did)` and returns 402 if `!isEntitled(billing)`. Wire as `dataRouter.use('*', requireAuth, requireEntitlement)`. Without this, the paywall is decorative.

### S2. Dev-mode billing shortcut is exploitable in production if `AUTUMN_SECRET_KEY` is missing or `AUTUMN_DISABLED` is set
**File**: `src/server/index.ts:730-765, 826-840`, `autumn-billing.ts:25-28`

`useLive` (autumn-billing.ts:25-28) returns false when `AUTUMN_SECRET_KEY` is unset. The checkout handler (`/api/billing/checkout`) takes that as a green light to write `status: 'active'` directly into the KV cache (line 731-736), no card, no Autumn round-trip. The same is true for `/api/billing/checkout/return` (line 826-840).

In production, anyone who can deploy without a valid Autumn key — or rotates a key, or the Autumn dashboard returns a 401 once and someone "temporarily" sets `AUTUMN_DISABLED` — turns the paywall off for new sessions, **for free**. There is no `NODE_ENV` guard around this branch.

Combined with S1, the paywall is currently bypassable two ways. After fixing S1, this is the second open door.

**Fix**: gate the dev shortcut on `c.env.NODE_ENV === 'development'`, not on `!useLive(env)`. In production, missing Autumn config should fail closed (503), not silently entitle the user.

### S3. Cookie `Secure` flag is conditional on `NODE_ENV`, but `wrangler.jsonc` sets `vars.NODE_ENV = "development"` at deploy time
**File**: `src/server/index.ts:514`, `wrangler.jsonc:62-65`

```ts
secure: c.env.NODE_ENV === 'production',
```

`wrangler.jsonc` declares `vars.NODE_ENV = "development"`. Unless the deployer sets `NODE_ENV=production` via `wrangler deploy --var NODE_ENV:production` or environment-specific vars, **the production deployment will set the session cookie without `Secure`**, allowing a passive MITM on a downgrade-to-`http://` redirect to read the session id.

The README does **not** instruct the deployer to flip `NODE_ENV` for production. This will silently ship insecure cookies on every default deploy. It also affects the dev-login route (line 666 hard-codes `secure: false`, which is correct), but the OAuth path is the live one.

**Fix**: Default to `secure: true` for the session cookie in production. The OAuth flow already detects loopback (line 313-316). Use that signal instead of `NODE_ENV`. Or remove `NODE_ENV` from `vars` entirely and require it via `--env production` deploy config.

### S4. Secrets are declared in `wrangler.jsonc`'s `vars` block (plaintext, committed)
**File**: `wrangler.jsonc:62-65`

```jsonc
"vars": {
    "NODE_ENV": "development",
    "AUTUMN_SECRET_KEY": ""
}
```

Cloudflare's docs are explicit: **"Do not use `vars` to store sensitive information."** `vars` are plaintext, visible in the Cloudflare dashboard, and committed to the repo. Even though the value here is empty today, the binding declaration tells the next deployer this is the right place to put a live key. The next person to set this will paste the live Autumn API key into a public, version-controlled file.

`SESSION_SECRET`, `ADMIN_TOKEN`, `RESEND_API_KEY`, `OAUTH_CLIENT_ID`, `RESEND_FROM` are all referenced from `Env` (server/index.ts:38-47). The README correctly documents these as `wrangler secret put` (lines 173-180), but `AUTUMN_SECRET_KEY` is contradicted by the wrangler config.

**Fix**: Delete `AUTUMN_SECRET_KEY` from the `vars` block. It's a `wrangler secret`, full stop.

### S5. `dev-login` route ships in production with a hardcoded fallback secret
**File**: `src/server/index.ts:631-673`

```ts
app.post('/api/auth/dev-login', async (c) => {
    if (c.env.NODE_ENV !== 'development') {
        return c.json({ error: 'Not allowed in production' }, 403)
    }
    // ...
    const secret = c.env.SESSION_SECRET || 'dev-secret-key-32-chars-long!!'
```

The route is correctly gated by `NODE_ENV !== 'development'`. **But** `NODE_ENV` is in `vars` defaulting to `"development"` (S3 above). So if the deployer follows the README and just runs `wrangler deploy`, `NODE_ENV` stays `"development"`, **the dev-login route is live, AND it falls back to the hardcoded secret if `SESSION_SECRET` is unset.** Anyone can `POST /api/auth/dev-login` with `{did: "did:plc:victim"}` and impersonate any user.

This is the compounding effect of S3 + S4: any one alone is sloppy; together they are an authentication bypass on a default deploy.

**Fix**: 
1. Remove the hardcoded secret fallback. If `SESSION_SECRET` is missing, return 500.
2. Default `NODE_ENV` to `production` when not set (or fail at startup if missing).
3. Strongly consider gating dev-login by request hostname (`url.hostname === '127.0.0.1' || === 'localhost'`), not by env var.

---

## P1 — significant correctness/security risk

### S6. SSRF host blocklist is incomplete and DNS-rebinding-vulnerable
**File**: `src/server/feed-fetch.ts:63-73`

```ts
function isBlockedHostname (hostname:string):boolean {
    const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
    return normalized === 'localhost' ||
        normalized === '0.0.0.0' ||
        normalized === '::1' ||
        normalized.endsWith('.local') ||
        normalized.startsWith('127.')
}
```

Missing:
- IPv4 private ranges: `10.*`, `172.16.0.0/12`, `192.168.*`. Cloudflare Workers fetch *generally* won't reach RFC1918 from public egress, but this is platform-dependent and unspecified. **Don't rely on it.**
- IPv4 link-local / metadata: `169.254.0.0/16` (AWS metadata, GCP metadata). Workers don't run on AWS, but if a user hosts a redirector at a normal hostname that 302s to `http://169.254.169.254/latest/meta-data/`, you happily follow it (default `fetch` follows redirects, this code doesn't override `redirect: 'manual'`).
- IPv6 unique-local `fc00::/7`, link-local `fe80::/10`, IPv4-mapped `::ffff:127.0.0.1`.
- Hostnames that resolve to a private IP via DNS — DNS rebinding. A user submits `http://attacker.com/feed.xml`; it resolves once for `validateFeedUrl` (no resolution actually happens — `validateFeedUrl` only checks the literal string), then on `fetch` resolves to `127.0.0.1`. There's no DNS pinning or post-resolve recheck.
- Numeric IP encodings: `http://2130706433/` (== `127.0.0.1` decimal-encoded), `http://0177.0.0.1/`, `http://0x7f.0.0.1/`. WHATWG URL parses these into `127.0.0.1`, but the `startsWith('127.')` check happens against the *parsed* hostname — let me verify: `new URL('http://2130706433/').hostname === '2130706433'`. **Yes**, hostname is the literal numeric form, so `startsWith('127.')` misses it. Verified manual testing required.
- `[::]` (all-zeros IPv6) is missed — `new URL('http://[::]/').hostname === '::'`, which is not in the blocklist.

**Fix**: 
1. Reject by parsing the hostname into an IP and checking against canonical CIDR blocks (write a small allowlist-of-public IP helper, or use a maintained library). Reject anything that fails to parse or resolves to a private/special-use IP.
2. Set `redirect: 'manual'` on the fetch and re-validate the location header before following, capping at 3 redirects.
3. Actually attempt resolution and pin the IP for the fetch (Cloudflare Workers don't expose this directly — closest you can get is to validate the *resolved* IP via a separate DNS-over-HTTPS lookup before fetch and reject if private).

### S7. `validateFeedUrl` doesn't lowercase scheme; `Http://` and `HTTPS://` slip through if someone changes the check
**File**: `src/server/feed-fetch.ts:28`

`url.protocol` from WHATWG URL parser is always lowercased — fine today. But the manual-redirect fix above (S6) needs to revalidate the redirect target, and a future maintainer who copies this code without using `URL` will reintroduce the bug. Not a current vuln; flag as a robustness gap.

### S8. `parseFeed`/`parseAtom` will OOM on hostile XML — no `<channel>` count cap, no `<item>` count cap, no per-field length cap
**File**: `src/server/durable-objects/index.ts:701-795`

`fast-xml-parser` is XXE-safe by default (it doesn't resolve external entities) — that addresses billion-laughs and external-entity SSRF. **But** a 5 MB feed (the body cap) can still encode 50,000+ `<item>` elements. The DO loops over every item and does `INSERT OR IGNORE` per row. With CF Worker free-tier 10ms CPU budget and paid 30s cap, a single hostile feed at refresh time can monopolize the alarm and stall every other feed.

Also: no cap on the size of `description`, `content`, `title`. DO SQLite has a default 1 MiB row size limit, but a 4 MB `<content>` field will cause the INSERT to fail and `// Ignore duplicate key errors` (line 680-682) swallows it silently with no `last_error` recorded. The user's feed will simply never show new items.

**Fix**: 
- Cap `parsedFeed.items.length` to e.g. 1000 before insertion; log and surface "feed too large" via `last_error`.
- Truncate per-field content to a sensible max (e.g. 1 MB for `content`, 64 KB for `description`, 8 KB for `title`).
- Don't blanket-swallow INSERT errors — log them so a malformed feed is observable.

### S9. Alarm doesn't bound its own work — `refreshFeeds` runs to completion regardless of CPU budget
**File**: `src/server/durable-objects/index.ts:891-913`

The alarm fetches all feeds and refreshes them with concurrency 8 (good — addresses prior P1 #14). But:
- A user with 500 feeds, each with a 15 s timeout, can accumulate enough wall time that the alarm exceeds the per-DO 30 s CPU cap on paid plans. CF will kill the request mid-refresh, and **the next-alarm reschedule at line 898 never runs**.
- `await this.ctx.storage.setAlarm(...)` is now correctly awaited (good — addresses prior P1 #15) — but only if the function reaches that line.

**Fix**: schedule the next alarm **before** doing the work (or with a `try/finally`), so a kill mid-refresh doesn't lose the schedule. Better: process feeds in batches across alarms — set the alarm for "next 100 feeds in 60 seconds" if you didn't finish.

### S10. CSRF: SameSite=Lax + cross-origin check is **almost** there, but loopholes remain
**File**: `src/server/index.ts:199-216, 230-249`

`isCrossOriginStateChange` (line 199-216) rejects POST/PATCH/DELETE/PUT when:
- `Origin` header is set to a non-allowed value, OR
- `Sec-Fetch-Site` is `'cross-site'`, OR
- No `Origin` and `Sec-Fetch-Site === 'same-site'`.

This catches most CSRF, but:
- A request with **no `Origin` header and no `Sec-Fetch-Site`** is allowed through. `Sec-Fetch-Site` is widely supported in modern browsers (Chrome/Firefox/Safari since 2020), but legacy clients and any non-browser client (curl, scripted attack from a developer tools console of another origin if cookies are sent — unlikely under SameSite=Lax but worth documenting) bypass this check.
- The `Origin` allowlist is `requestUrl.origin || appOrigin`. `appOrigin` defaults to `https://rsss.space` (line 182). A staging environment at `https://staging.rsss.space` whose `APP_ORIGIN` env var is unset will **silently accept cross-origin POSTs from `rsss.space`** — probably fine for you specifically, but the default is "production origin trusts production origin," which leaks across environments.
- **No CSRF token.** Pure header-based protection is fragile against XS-Leaks and the moment you add a CDN, proxy, or client SDK that strips `Origin`.

**Fix**: At minimum, reject requests without **both** `Origin` and `Sec-Fetch-Site` for state-changing methods. Better: issue a CSRF token in a header-readable cookie at session creation, require `X-CSRF-Token` echo on all state-changing routes.

### S11. `withIsolationHeaders` only sets COOP/COEP for HTML and JS responses
**File**: `src/server/isolation-headers.ts:6-12`

```ts
if (!ct.includes('text/html') && !ct.includes('javascript') && ct !== '') {
    return response
}
```

The intent is "only the document needs cross-origin isolation." That's correct for COOP. For **COEP `credentialless`**, the document policy applies regardless of subresource content type. That's fine.

**But** there's a subtle bug: `ASSETS.fetch` for static files (PNG, manifest.json, .ico) returns those without isolation headers — fine. The /api/* JSON responses get content-type `application/json`, so `ct.includes('javascript')` is false — they don't get COOP/COEP. **That's mostly fine** for API calls, but it means a same-origin attacker who can `iframe('/api/feeds')` (an HTML response would be needed) can't, but a window navigated to `/api/feeds` is a JSON response which won't get COOP isolation. This is mostly theoretical.

The **real** issue: `credentialless` instead of `require-corp` (line 21) was the right call given the third-party iframe constraint (prior P1 #17). But `credentialless` strips cookies on any cross-origin subresource — that means feed thumbnails and OG images **fetched from third-party origins won't carry cookies**, which the app probably doesn't care about, but warrants explicit testing. No findings yet; flag as untested.

### S12. CORS allows credentials with origin echo, but origin allowlist accepts the request URL's origin without further checks
**File**: `src/server/index.ts:218-228`

```ts
function allowedCorsOrigin (origin, c) {
    const appOrigin = appContext.env.APP_ORIGIN || DEFAULT_APP_ORIGIN
    return isAllowedRequestOrigin(origin, appContext.req.url, appOrigin) ?
        origin : null
}
```

`isAllowedRequestOrigin` (line 190-197) returns true if `origin === requestOrigin`. So a cross-origin browser POST to `https://attacker.com/api/foo` with `Origin: https://attacker.com` — wait, that's not a thing because the request URL is your worker's URL. Re-read: `requestOrigin = new URL(requestUrl).origin` — that's the worker's own origin. `origin === requestOrigin` is true only when the request is same-origin, which by definition wouldn't have CORS to deal with. So the only meaningful clause is `origin === appOrigin`.

That's fine *if* `APP_ORIGIN` is correctly set. If it's not (and there's no startup check), it defaults to `https://rsss.space`. A deployment at `https://my-staging.example` will silently accept `Origin: https://rsss.space` for credentialed cross-origin requests. Low impact (you'd have to be both at that origin and have stolen a cookie), but the default is wrong.

**Fix**: require `APP_ORIGIN` to be set at startup; refuse to boot without it. Or default to the request origin only.

### S13. `verifySessionCookie` does not validate `record.session` shape after JSON.parse
**File**: `src/server/auth/oauth.ts:656-665`

```ts
const record = JSON.parse(recordJson) as StoredSession
if (typeof record.sessionExpiresAt !== 'number' ||
    record.sessionExpiresAt < Date.now()) { ... }
return record.session
```

The cast is unchecked. If KV returns a corrupted record (or one written by an older code path that didn't have `sessionExpiresAt`), `record.session` could be `undefined` and downstream code at `c.set('session', session)` and `requireAuth` (line 567-571) would treat `undefined` as falsy and reject — fine. But if `record.session = "string"` or `{}`, the request goes through with a malformed session and `session.did` is `undefined`, which then becomes the DO id (line 622-624: `env.USER_DO.idFromName(did)` — `idFromName(undefined)` will throw, but this is only one of several downstream paths).

**Fix**: validate `typeof record.session === 'object' && typeof record.session.did === 'string' && typeof record.session.handle === 'string'` before returning.

### S14. Push idempotency claim is **mostly true but breaks for URL-canonicalized add-feed retries**
**File**: `src/server/durable-objects/index.ts:178-274`, README:74-78

The README claims: "v1 does not store a processed-op table on the server: add-feed retries use the unique feed URL as the idempotency key."

`validateFeedUrl` returns `url.toString()` (feed-fetch.ts:36). WHATWG URL canonicalization only normalizes a few things — case in scheme/host, default port stripping, Punycode for IDN — but does **not** follow redirects or strip trailing slash differences. So:
- User adds `https://example.com/feed`. Inserted as `https://example.com/feed`.
- Retry of the same outbox row sends the exact same URL — fine, hits the existing-row branch (line 210-234), returns 409 with `{feed}` and the client reconciles.
- User adds `https://Example.COM/feed/` (different submission). This canonicalizes to `https://example.com/feed/` — different from `https://example.com/feed` (trailing slash). **A second row gets inserted.** The user sees both feeds, which probably parse to the same content.

Not the worst bug, but the README's claim is over-confident.

**Fix**: either document the limitation, or normalize trailing slash + lowercase host explicitly before insert.

### S15. `client_updated_at` is trusted blindly — clients can pin themselves to win every conflict
**File**: `src/server/durable-objects/index.ts:220-230, 309-313, 478-483, 515-534`

The LWW logic compares `serverTs > body.client_updated_at`. There's no clamp on what `client_updated_at` can be. A client (malicious or buggy) sends `client_updated_at: '9999-12-31T23:59:59'` and **always wins** every conflict — server-side state is overwritten by client values.

For a single-user-per-DO model this is "the user wrote whatever they wrote, that's their data." But: a user who's compromised on one device can poison their own DO state in ways that survive forever (no other source of truth). And if two devices race (rare for a single user), the device with the largest claimed timestamp wins regardless of actual physical ordering.

**Fix**: clamp `client_updated_at` server-side: `min(client_updated_at, now() + 5min)`. If clamping triggers, log it so future-you can spot misbehaving clients.

### S16. `sync` endpoint serves up to **all rows** with no pagination cap
**File**: `src/server/durable-objects/index.ts:549-616`

`/sync?since=...` returns every changed feed and item since the timestamp, no `LIMIT`. A first-time bootstrap (`since` omitted) returns *the entire database*. For a user with 50 feeds × 1000 items each = 50,000 items, the response body is many MB. CF Workers have a 100 MB response cap for paid; free tier lower. The body also has to be JSON-encoded and held in memory.

Plus: 50,000 items × ~2 KB each = 100 MB JSON payload. The DO will hit a memory or response-size limit and return 5xx, killing bootstrap forever.

**Fix**: paginate `/sync`. Return `nextSince` cursor; client iterates. The README mentions "paging through `/api/sync`" (line 69) but the server implementation doesn't actually page.

### S17. Feed parser drops items silently when `INSERT` fails for any reason (size, encoding, FK violation)
**File**: `src/server/durable-objects/index.ts:680-682`

```ts
} catch (_err) {
    // Ignore duplicate key errors
}
```

The comment lies. The catch is **bare**: it ignores duplicate key errors AND row-too-big errors AND foreign-key errors AND constraint violations AND every other SQL error. A user with a broken feed will never know — it just shows "no new items" forever.

**Fix**: distinguish duplicate-key (expected, ignorable) from other errors (log + record `last_error`). SQLite raises distinct error codes for unique violations; check.

### S18. `/feeds/:id/refresh` is a per-user DOS amplifier with no rate limit
**File**: `src/server/durable-objects/index.ts:321-340`, server/index.ts:1025

Any authenticated user can hammer `POST /api/feeds/:id/refresh` thousands of times per second. Each call hits the DO, which calls `fetchFeed` which makes an outbound HTTP request. No CF rate limit is configured (`wrangler.jsonc` has none), and the DO single-threads requests but each one still makes a real HTTP call to a third-party feed.

**Use cases**: an attacker with a free login + the cancelled subscription (S1: paywall not enforced) can force-refresh a feed at line speed, using your account quota to DOS a third-party feed publisher. You become an unwitting attack tool.

**Fix**: per-DO rate limit on `fetchFeed` — e.g. min 60 seconds between fetches per feed, in DO storage. Or wire CF rate-limiting rules.

### S19. `Resend.emails.send` can be triggered by user-supplied `email` field in `/api/billing/checkout` and `/api/billing/checkout/failed` — no rate limit
**File**: `src/server/index.ts:704-801, 915-983`

`/api/billing/checkout` accepts `body.email`, validates with `isProbablyEmail`, stashes in KV (line 723). The resulting `sendSubscriptionStarted` (in dev mode at line 738-758) emails whatever the user provided. A logged-in user can call `/api/billing/checkout` with arbitrary recipient emails — though `sendOnce` dedupes by `did:planId:event:weekIndex`, **the first call always fires**. So per week, per plan, an attacker can send *one* RSSS-branded email to any address they choose. Spam-amplification one-per-week per attacker per recipient — bounded but exploitable for phishing campaigns ("RSSS confirmed your subscription, click to verify").

**Fix**: don't trust `body.email` for the outgoing recipient. The sub-confirmation email should go to the email Autumn has on file (`customer.email`), never to a client-submitted address. The `stashPendingEmail` flow is fine for *recording* what email Autumn should bind, but the actual outgoing recipient must be Autumn-verified.

### S20. `app.get('/logout', ...)` — GET request triggering destructive action
**File**: `src/server/index.ts:550-561`

GET shouldn't be destructive. `Logout` deletes the KV session record. Any image or `<a>` tag with `href="/logout"` rendered into the user's view (e.g. via an XSS in a feed title that escapes DOMPurify, or a malicious bookmarklet, or a same-origin iframe with `<img src="/logout">`) will log them out. That's not catastrophic, but it's also a CSRF anti-pattern.

The dedicated `/api/auth/logout` POST exists at line 537-548 with the same logic. Why does `/logout` GET also exist? Probably for the "sign out" link in nav. Use POST + form, or POST + fetch.

**Fix**: drop the GET handler, or convert it to redirect to the login page after instructing the client to POST.

---

## P2 — robustness/operational gaps

### S21. README says "encrypted session cookies" — they are signed, not encrypted
**File**: `README.md:90, 167, 205`

> "Session management with encrypted cookies"
> "Secret used to encrypt session cookies"
> "session cookies can no longer be decrypted"

The cookies carry a session id (just an opaque random string in base64) signed with HMAC-SHA256. The KV record itself is plaintext JSON. Nothing is encrypted.

This was a real lie pre-P0-#3 fix and is still a lie post-fix; the only difference is now the *plaintext* in the cookie is just a session id rather than tokens. The technical correction is the same: this is signed, not encrypted.

**Fix**: README wording → "signed session cookies" / "secret used to sign session cookies."

### S22. No handler for Autumn webhooks / no signature verification
**File**: search across `src/server/`

The codebase polls Autumn (`verifySubscription` is called on demand) but never receives webhooks. That's actually defensible — pull-only — but means:
- A user who cancels via the customer portal stays "entitled" for up to 10 minutes (KV cache TTL, line 56). Acceptable.
- A user whose payment **fails after** an active subscription (mid-cycle) stays entitled until the cache expires. Then the next refresh hits Autumn and reverts. If a 24-hour cache is ever introduced, this widens. Acceptable today.
- No reconciliation of disputed charges or chargebacks. If Autumn supports webhook-driven entitlement loss, you're not using it.

**Fix**: optional, but document that "we poll, we do not subscribe to webhooks."

### S23. No request logging beyond `console.log`; no error tracking
**File**: server/index.ts (numerous `console.error` calls), wrangler.jsonc:67-69

`observability.enabled = true` enables CF Workers logs, which is fine — you'll see request logs in the dashboard and Logpush. But:
- Every `console.error` includes the raw `err` object, which on caught Resend errors includes the API request body (line 159-166 in email.ts). That body contains user emails. **PII in logs.**
- No Sentry or equivalent. CF tail logs are not searchable post-hoc unless you've enabled Logpush to a destination.

**Fix**: structured logging. Strip `err.message` to a safe shape before `console.error`. Or wire Sentry (`@sentry/cloudflare`).

### S24. `ctx.waitUntil(this.fetchFeed(...))` on add-feed silently swallows fetch errors
**File**: `src/server/durable-objects/index.ts:256, 684-695`

Add-feed returns 201 immediately and fires `fetchFeed` in the background — good UX (fixes prior P1 #13). But errors during the background fetch are swallowed inside `fetchFeed` (which catches and writes `last_error` to the row). If the user never refreshes the feed list, they'll never see the error. The list endpoint returns rows including `last_error`, so the UI can surface it — sibling owns the client question of whether it does.

The bigger nit: there's no bounded retry. The 10-minute alarm will retry the failed feed forever.

**Fix**: increment a `consecutive_failures` column; after N=5 consecutive failures, downgrade the refresh interval (1 hour, then 1 day) or surface a "feed broken" UI signal.

### S25. Constructor still introspects `PRAGMA table_info` on every wakeup if migration version is current
**File**: `src/server/durable-objects/index.ts:89-113`

Wait — re-read. `migrateAddUpdatedAt` and `migrateAddFeedFailureColumns` only run if `migration_v !== USER_DO_MIGRATION_VERSION`. **Good, this addresses prior P2 #24.**

But `initDatabase` still runs `TABLES_SQL`, `INDEXES_SQL`, `TRIGGERS_SQL`, `DEAD_LETTER_OUTBOX_SQL` every wakeup. Those are all `IF NOT EXISTS`, so they're cheap, but they do run. Fine.

The tiny remaining wart: `this.sql.exec('PRAGMA foreign_keys = ON;')` (line 90). PRAGMAs in DO SqlStorage **do not persist across hibernation** — every constructor run must re-set this. Not a bug, but worth a comment so it doesn't get refactored away.

### S26. Feed-fetch User-Agent claims "RSSS/1.0 RSS Reader"
**File**: `src/server/feed-fetch.ts:48`

Some feeds rate-limit by UA. A specific UA string is fine, but if feed publishers block it, you'll get 403s with no observability into why (line 53-58 throws on any non-2xx). Consider including a contact URL: `'RSSS/1.0 (+https://rsss.space/info)'` so blocked-by-mistake publishers can find you.

### S27. Mark-all-read with no `feed_id` and no `client_updated_at` is **unconditional**, no LWW guard
**File**: `src/server/durable-objects/index.ts:506-546`

If the client doesn't send `client_updated_at`, line 542 unconditionally marks every item as read with no conflict check. The push-sync code does send `client_updated_at` (push-sync.ts:268-269). But a future client (or curl) that omits it gets a free pass. Defensive coding would require it.

**Fix**: 400 if `client_updated_at` is missing.

### S28. PATCH /items/:id allows toggling `is_starred` cross-contamination via missing field validation
**File**: `src/server/durable-objects/index.ts:463-503`

The body type is `{is_read?, is_starred?, client_updated_at?}`. If a malicious client sends `{is_read: 1.5}` or `{is_read: 'truthy-string'}`, the ternary `body.is_read ? 1 : 0` (line 488) coerces to 1. That's actually *correct* behavior given the types, but `body.is_read !== undefined` (line 485) is true even if the field is `null`, in which case `null ? 1 : 0` evaluates to 0 (mark unread). A client that accidentally sends `{is_read: null}` clears the flag.

**Fix**: explicit `typeof body.is_read === 'boolean'` check.

### S29. `fast-xml-parser` 5.x default options — verify XXE / external entity handling
**File**: `src/server/durable-objects/index.ts:43-49`

`fast-xml-parser` 5.x doesn't process DTDs by default and doesn't resolve external entities — fast-xml-parser is a "no-XXE" parser. **You're fine here.** Flagging because the prior nitpicker review (#12) called this out and the response was to switch to `fast-xml-parser`, which is the right answer. Documenting for future reviewers: this is intentional.

### S30. `SQL injection`: all queries use `?` placeholders. One small concern: `routeQuery` builder
**File**: `src/server/durable-objects/index.ts:428-441`

```ts
const routeQuery = routeCandidates
    .map(() => 'items.link = ?')
    .join(' OR ')
const item = this.sql.exec(
    `SELECT items.*, ... WHERE items.link IS NOT NULL AND (${routeQuery}) ...`,
    ...routeCandidates
).one()
```

Fine — `routeQuery` only contains literal SQL fragments, never values. Values go through `?` placeholders. **No injection.**

### S31. `dataRouter` proxies headers wholesale to the DO — `Authorization` header passed through
**File**: `src/server/index.ts:1041-1047`

```ts
const response = await stub.fetch(
    new Request(doUrl.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
        ...
    })
)
```

All client headers are forwarded into the DO request. Most are harmless; but a client could set `Authorization: Bearer <something>` and the DO would see it. Today the DO ignores it. If admin-style routes are ever added inside the DO (and forget the worker has already done auth), this is a confused-deputy hazard.

**Fix**: pass only the headers the DO actually needs (Content-Type, x-forwarded-for if you start logging, custom RSSS headers).

### S32. No tests for the billing-gate logic — because there isn't one
This is a tautology since S1 is the bug, but: the test suite (`test/run-all-tests.mjs`) covers OAuth callback static analysis, sidebar, signup, but no test verifies that `/api/sync` returns 402 for an un-entitled user. There's no entitlement test because there's no entitlement.

### S33. `parseDate` returns `toISOString()` (`'2026-04-25T...'`) into `pub_date` — same format mismatch as updated_at
**File**: `src/server/durable-objects/index.ts:869-879`

`parseDate` returns ISO format. `created_at` and `updated_at` use SQLite `datetime('now')` (space format). Sorting by `pub_date DESC, created_at DESC` (line 378, 438) compares ISO `pub_date` (with `T`) against ISO `pub_date` — fine internally. But mixing the formats across tables means string comparisons across `pub_date` and `created_at` would be wrong if you ever did one. Today you don't. Documented limitation; flag for future.

### S34. `app.get('/health')` does not exist; only `/api/health` exists
**File**: `src/server/index.ts:288-290`

Prior nitpicker review claimed both `app.get('/health', ...)` and `app.get('/api/health', ...)` exist (line 444). Re-checking the current code: only `/api/health` exists. Prior P3 #45 is already addressed (or was a misread). Closed.

### S35. `wrangler.jsonc` has stale migrations
**File**: `wrangler.jsonc:26-36`

```jsonc
{ "tag": "v1", "new_sqlite_classes": ["CollieUserDO"] },
{ "tag": "v2", "deleted_classes": ["CollieUserDO"], "new_sqlite_classes": ["UserDO"] }
```

`CollieUserDO` is a leftover from a different project (presumably renamed). Migrations are append-only in CF; deleting them isn't safe once deployed. Verify this matches what's actually in production. If not, you'll get a deploy failure or class mismatch on next push.

Also: there's no migration for adding non-SQLite classes (none currently), so this is just historical noise. Comment it.

### S36. `noindex` on auth-walled pages
**File**: `index.html`, server response headers

The HTML doesn't include `<meta name="robots" content="noindex">` and the worker doesn't set `X-Robots-Tag`. The login page (`/login`) and authenticated routes (`/feeds`, `/settings`, etc.) will be indexed by Google if any link points to them. For a paid SaaS, the article-reader URLs (`/item/<route>`) probably shouldn't be indexed even if accessible.

**Fix**: server-set `X-Robots-Tag: noindex, nofollow` on all responses except a curated allowlist (`/`, `/signup`, `/info`, `/terms`, `/privacy`).

### S37. No HSTS header
**File**: `src/server/isolation-headers.ts` and middleware stack

`Strict-Transport-Security` is not set. CF Pages/Workers default to HTTPS, but a manual user typing `http://rsss.space` will follow the redirect once and only get HTTPS thereafter if the *browser* upgrades — which it won't unless HSTS is set or the user is preloaded.

**Fix**: add `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` for production responses.

### S38. `/oauth/client-metadata.json` advertises `dpop_bound_access_tokens: true` but DPoP is no longer used post-token-exchange
**File**: `src/server/index.ts:344-360`

Bluesky requires this to be true for DPoP-bound issuance, but the client metadata also says you support DPoP requests — and you don't, the keys are immediately discarded. From Bluesky's perspective this is fine (they don't validate that you keep the keys). From a maintainability perspective, future-you will assume DPoP is wired up. Add an inline comment in the metadata declaring "we do not call PDS, this is the minimal AT Protocol claim."

---

## P3 — nits, style, polish, doc drift

### S39. Commit messages remain garbage
`git log` recent: `add tests`, `wip`, `add notes about law`, `wip`, `Merge branch 'oauth' into staging`. Prior nitpicker review #41 called this out — **ignored.** Re-flagging with mild contempt. You will not bisect anything in this repo.

### S40. CLAUDE.md says no spaces around `:` in TS types — server/index.ts mostly follows it now, but mixed in oauth.ts
**File**: `src/server/auth/oauth.ts`

Lines 9-13, 25-29 use the spaced style (`did: string`). Most server code now uses no-space (`did:string`). Pick one and lint. Prior #42 flagged this; partially fixed in newer code, but oauth.ts wasn't touched.

### S41. `parseInt` without radix
**File**: `src/server/durable-objects/index.ts:278, 290, 322, 356-357, 365, 379, 389`

Most calls pass `, 10` now (lines 278, 290, 322, 365). Some still don't (line 356, 357 — `parseInt(c.req.query('limit') || '50', 10)` does pass radix; my apologies, let me double-check). Re-reading... they all pass radix now. Prior P3 #47 is **fixed**. Closed.

### S42. Dead code: `restoreDPoPKeyPair` is private, only used by `exchangeCode` — fine; no longer dead.
The `OAuthState` interface still carries `dpopPrivateKeyJwk` / `dpopPublicKeyJwk` — necessary for the PAR/token exchange flow. Not dead. Closed.

### S43. `app.post('/api/auth/dev-login', ...)` runs Hono's `c.req.json()` without try/catch
**File**: `src/server/index.ts:631-673`

If a dev fires `POST /api/auth/dev-login` with no body or non-JSON body, `c.req.json()` throws and Hono returns a 500. Should default to `{}`. Other routes do `await c.req.json().catch(...)`. Be consistent.

### S44. `escapeHtmlAttr` is identical to `escapeHtml`
**File**: `src/server/email.ts:322-324`

```ts
function escapeHtmlAttr (s:string):string {
    return escapeHtml(s)
}
```

Either drop the function or document why it exists (intent: keep separate so attr-specific escaping can be added later). Right now it's a confusing identity function.

### S45. `ASSETS` Fetcher is referenced but `assets.run_worker_first: true` means **worker** sees the request first
**File**: `wrangler.jsonc:55-60`

The `app.all('*', ...)` fallback at server/index.ts:1150-1157 falls through to `c.env.ASSETS.fetch(c.req.raw)`. Combined with `run_worker_first: true`, every request hits the worker and the worker decides whether to serve assets. That's fine. Worth a comment so the next maintainer knows static asset 404s come from the worker, not CF's static asset matcher.

### S46. `/api/auth/callback` doesn't bind state to session
**File**: `src/server/index.ts:426-532`

OAuth state is stored under `oauth:<nonce>` in KV, looked up by the `state` parameter from the callback. If a user starts two simultaneous logins (two tabs), or an attacker can guess a nonce (random 16-char base64 → 96 bits, fine), they can complete a flow with someone else's state — but the flow returns the OAuth tokens to whoever calls back, so this is mostly an academic concern. Worth noting that there's no per-user binding (no IP check, no fingerprint).

### S47. `text + decoder.decode()` flush in readBoundedText
**File**: `src/server/feed-fetch.ts:112`

`return text + decoder.decode()` — the empty-input flush of a streaming TextDecoder. Correct, but obscure. A one-line comment "// flush any incomplete UTF-8 sequence" would help.

### S48. `pendingEmailKey` and `billingCacheKey` share the SESSIONS namespace alongside actual sessions
**File**: `src/server/index.ts:59-65`

Keys: `session:<sid>`, `oauth:<nonce>`, `user:<did>`, `billing:<did>`, `billing_pending_email:<did>`, `email_sent:<did>:...`. All sharing the SESSIONS KV. KV.list operations (e.g. `/admin/users`) prefix-filter, so no collision. But it's growing and a separate "RSSS_STATE" KV would be cleaner long-term.

### S49. The OAuth client metadata is served from the same origin that handles auth — not strictly wrong, but it means rotating origins is a multi-step dance because Bluesky caches the client metadata
**File**: `src/server/index.ts:341-361`

If you ever change `appOrigin`, every existing AT Protocol auth server will have a stale `client_id` cached. Document the rotation procedure.

### S50. `OAuthState.returnTo` has no allowlist
**File**: `src/server/index.ts:404-410`

```ts
const { authUrl, state } = await startOAuthFlow(body.handle, clientId, redirectUri, '/')
```

`returnTo` is hardcoded to `'/'` here, so safe. But `startOAuthFlow` accepts a 4th arg and exchanges put it in storedState; line 522 reads `storedState.returnTo || '/'` and the SPA uses it as a redirect. If a future caller passes user-controlled `returnTo`, an attacker can craft `returnTo=https://evil.example` for an open redirect. Today: not exploitable. Add a same-origin assertion before storing.

---

## Categories with no findings (or findings unchanged from prior)

- DO-internal SQL injection: clean (placeholders everywhere).
- HMAC implementation: WebCrypto-backed, unchanged from prior, correct.
- Foreign keys: PRAGMA correctly enabled (line 90 server, sibling owns client). Prior P1 #10 addressed.
- Dead-letter outbox: implemented. Prior P1 #11 addressed.
- Outbox attempt cap: implemented at OUTBOX_ATTEMPT_LIMIT=10 (push-sync.ts:10). Prior P1 #11 addressed.
- DO concurrency cap on alarm: 8 (FEED_REFRESH_CONCURRENCY). Prior P1 #14 addressed.
- Alarm reschedule: now `await`ed (line 898). Prior P1 #15 addressed.
- Tab coordination: tests exist (`test/tab-coordination.ts`). Sibling owns deeper review.

---

## Closing remarks

The previous round of P0s have all been substantively fixed: the session cookie no longer carries plaintext OAuth tokens, the regex-toy sanitizer is gone, the admin endpoints are gated, DPoP keys are correctly discarded, and there's now a real SSRF-defense module. That is real progress and not nothing.

The new top-of-list issues are all about the **paid-feature paywall**: the server simply does not enforce it (S1), the dev shortcut is exploitable in production (S2), and the deploy story silently ships insecure cookies + an active dev-login route (S3, S4, S5). Nothing about the data-loss path is broken; everything about "people pay for this and free riders can't get it" is.

The other big theme: this is a feeds product, and the feeds path remains the trust boundary. SSRF is mitigated (good) but not finished (S6). Hostile-feed DOS (S8, S9, S17) is still real. Rate limiting is essentially absent (S18, S19).

After fixing the paywall + secrets-in-vars story, this is shippable. About a half-week of focused work for one engineer. I am cautiously less hostile than two days ago.
