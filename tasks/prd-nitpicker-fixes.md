# PRD: Nitpicker P0 + P1 Remediation and Test Coverage

## Introduction

Two reviews — `nitpicker-client.md` (client-side local-first cache and sync) and `nitpicker-server.md` (server, security, production-readiness) — identified launch-blocking and significant correctness issues in the RSSS codebase. This PRD consolidates the P0 and P1 findings into actionable user stories and adds a separate test-coverage track addressing CI gaps.

The scope is limited to issues that would either lose user data, expose users to exploitation, or constitute significant correctness/security risk. P2/P3 nits are deliberately excluded.

## Goals

- Eliminate every P0 finding before public launch (no data loss, no exploitable bypass).
- Resolve every P1 finding before public launch (no significant correctness or security risk).
- Wire all client-side test files into CI so the green checkmark reflects actual coverage.
- Add regression tests for each fix so the same class of bug cannot recur silently.
- Keep paid-feature paywall enforcement on the server, not just the client.

## User Stories

User stories are grouped by priority (all P0s first, then P1s, then test-coverage). Each fix story requires a regression test that fails before the fix and passes after.

---

### P0 — would lose user data or be exploited

#### US-001: Paginate `/api/sync` end-to-end (client + server)
**Description:** As a user with a large feed backlog, I want bootstrap and incremental sync to page through results so I do not OOM the worker, the browser, or the network.

**Source:** Client P0-1, Server S16.

**Acceptance Criteria:**
- [ ] DO `/sync` accepts a cursor (`(updated_at, id)`) and a `limit` (hard cap 500 items per page); returns `{feeds, items, hasMore, nextCursor, latestUpdatedAt}`.
- [ ] No `SELECT *` on feeds/items without `LIMIT` and `WHERE (updated_at, id) > cursor` ordering.
- [ ] Client `pull-sync` and `bootstrap` loop until `hasMore === false`.
- [ ] Cursor is committed per-page so a resumed bootstrap does not redo completed pages.
- [ ] Bootstrap progress signals tick per page, not per item-loop iteration.
- [ ] Regression test: 1500-item dataset bootstraps in 3+ pages without OOM and without losing rows on simulated network interruption between pages.
- [ ] Typecheck and lint pass.

#### US-002: Distinguish transient from terminal bootstrap errors
**Description:** As a user with a flaky network, I want a transient bootstrap failure to leave my settings and OPFS file alone so I can retry without losing my preference.

**Source:** Client P0-2.

**Acceptance Criteria:**
- [ ] `bootstrapLocalDb` `catch` classifies errors as transient (network, 5xx, abort) or terminal (corruption, schema mismatch, quota).
- [ ] Transient: leave `syncSubscriptions` on, leave OPFS file in place, surface a retry button via a signal.
- [ ] Terminal: prompt user before wiping OPFS or flipping the toggle off.
- [ ] No `setSyncSubscriptions(false)` or `removeOpfsDb` call outside the terminal branch.
- [ ] Regression test: simulated `fetch` rejection during bootstrap leaves `syncSubscriptions === true` and the OPFS file present; user-triggered retry succeeds.
- [ ] Typecheck and lint pass.

#### US-003: Fix `add_feed` reconciliation cascade-deleting local item state
**Description:** As a user who marked items read on an offline-added feed, I want my read/star state to survive when the feed is reconciled with its server-canonical id.

**Source:** Client P0-3.

**Acceptance Criteria:**
- [ ] `reconcileSuccessfulAddFeed` does not issue a cascade-causing `DELETE FROM feeds WHERE id = ?` when items are attached.
- [ ] After reconcile, items previously attached to the optimistic feed are reattached to the server-canonical feed id with their original `is_read` and `is_starred` values.
- [ ] Regression test: add feed offline, mark two items read and one starred, push sync (server returns canonical id), assert all three flags survive on the new feed id.
- [ ] Typecheck and lint pass.

#### US-004: Stabilize `update_item` outbox payload and verify both directions
**Description:** As a user toggling read/unread or star/unstar, I want the local row, outbox payload, and server PATCH to agree on the value being committed.

**Source:** Client P0-4.

**Acceptance Criteria:**
- [ ] Outbox `update_item` payload booleans match what was actually written to the local items row (no boolean/0-1 divergence between payload and row).
- [ ] Regression test covers `is_read: false` (mark unread) and `is_starred: false` (unstar), not just the `true` direction.
- [ ] Regression test covers toggle-toggle-toggle within one drain window: final local state matches final outbox row write.
- [ ] Typecheck and lint pass.

#### US-005: Single timestamp source for items/feeds writes
**Description:** As the sync system, I need every `updated_at` write to use one timestamp source so that `last_pull_at` string comparisons do not lose rows.

**Source:** Client P0-5.

**Acceptance Criteria:**
- [ ] Every place that writes `updated_at` uses `formatSqliteTs(new Date())` (or the inverse: a single `datetime('now')` everywhere — pick one and apply uniformly).
- [ ] No SQL fragment combines `formatSqliteTs(...)` with `datetime('now')` for the same row write.
- [ ] `last_pull_at` written by the client uses the same format as values used in the DO's `WHERE updated_at > ?` clause.
- [ ] Regression test: server returns `latestUpdatedAt`, client immediately writes a row, next pull's `since` does not skip that row even when the values are within one second of each other.
- [ ] Typecheck and lint pass.

#### US-006: Replace BroadcastChannel-only tab coordination with Web Locks API
**Description:** As a user with multiple tabs open, I want only one tab to hold the OPFS handle, with crash-safe lock semantics, so I never see "Local data is open in another tab" after a tab dies.

**Source:** Client P0-6.

**Acceptance Criteria:**
- [ ] `navigator.locks.request('rsss-opfs', { mode: 'exclusive' }, ...)` is the source of truth for primary-tab status.
- [ ] BroadcastChannel is removed or demoted to UI-status hint only.
- [ ] Tab crash (force-kill, not graceful close) releases the lock automatically; another tab acquires it without user refresh.
- [ ] Regression test: two tabs, primary tab killed, second tab acquires the lock and starts using the local adapter without page refresh.
- [ ] Regression test: bootstrap-in-progress race (Tab A bootstrapping, Tab B opens) — Tab B does not silently stay on remote adapter forever.
- [ ] Typecheck and lint pass.

#### US-007: Reuse SQLite worker across probe and open
**Description:** As a user on a slow filesystem, I want OPFS-SAH-pool installed once per session, not on every probe and every retry, so page load is not bloated by directory walks.

**Source:** Client P0-7.

**Acceptance Criteria:**
- [ ] `probeOpfsSupport` and `openLocalDb` share a worker, or the probe result is cached for the session and skipped on subsequent opens.
- [ ] No duplicate `installOpfsSAHPoolVfs` invocations across probe + open in the steady-state session.
- [ ] Regression test: instrumented test asserts `installOpfsSAHPoolVfs` is invoked exactly once per fresh session across probe and open.
- [ ] Typecheck and lint pass.

#### US-008: Auto-recover and notify when OPFS lock becomes available
**Description:** As a user whose tab fell back to the remote adapter, I want it to upgrade to local automatically when another tab releases the lock.

**Source:** Client P0-8.

**Acceptance Criteria:**
- [ ] When a `released` BroadcastChannel message (or Web Locks acquisition, post-US-006) makes the lock available, the blocked tab automatically attempts re-acquire and triggers `pullSync`.
- [ ] A signal bumps when the lock state transitions so the UI can re-render.
- [ ] Regression test: simulate lock-release event; assert `getAdapter` returns the local adapter on the next call without manual refresh and a sync is triggered.
- [ ] Typecheck and lint pass.

#### US-009: Add server-side billing entitlement gate to `dataRouter`
**Description:** As the operator of a paid product, I want every `/api/sync`, `/api/feeds`, `/api/items` route to require a current entitlement so non-paying users cannot use the sync infrastructure.

**Source:** Server S1.

**Acceptance Criteria:**
- [ ] `dataRouter.use('*', requireAuth, requireEntitlement)` (or equivalent) blocks unentitled sessions with `402 Payment Required`.
- [ ] `requireEntitlement` calls `resolveBilling(c.env, session.did)` and returns 402 when `!isEntitled(billing)`.
- [ ] Existing client `SyncBillingError` / `PushSyncBillingError` paths trigger correctly when the server returns 402.
- [ ] Regression test: an authenticated session with no entitlement receives 402 from `/api/sync`, `/api/feeds`, `/api/items`, `/api/items/mark-all-read`, `/api/feeds/:id/refresh`.
- [ ] Regression test: entitled session continues to receive 200/201/204 as appropriate.
- [ ] Typecheck and lint pass.

#### US-010: Gate dev billing shortcut on `NODE_ENV === 'development'`, not `!useLive(env)`
**Description:** As the operator, I want missing or disabled Autumn config in production to fail closed (503), not silently entitle every user for free.

**Source:** Server S2.

**Acceptance Criteria:**
- [ ] `/api/billing/checkout` and `/api/billing/checkout/return` write `status: 'active'` to KV only when `c.env.NODE_ENV === 'development'`.
- [ ] In production with missing/disabled Autumn config, return 503.
- [ ] Regression test: `NODE_ENV='production'` + `!useLive(env)` → 503; `NODE_ENV='development'` + `!useLive(env)` → existing dev behavior.
- [ ] Typecheck and lint pass.

#### US-011: Default cookie `Secure` flag to true; do not depend on `vars.NODE_ENV`
**Description:** As a user logging in over HTTPS, I want the session cookie to always carry `Secure` in production so a downgrade-to-`http://` redirect cannot leak my session id.

**Source:** Server S3.

**Acceptance Criteria:**
- [ ] Session cookie sets `Secure: true` unless the request is loopback (use existing loopback detection at oauth.ts:313-316 or hostname check).
- [ ] Removed reliance on `c.env.NODE_ENV === 'production'` for the `Secure` flag decision.
- [ ] Regression test: session cookie issued for `https://rsss.space` host carries `Secure`; session cookie issued for `http://127.0.0.1` does not.
- [ ] Typecheck and lint pass.

#### US-012: Remove `AUTUMN_SECRET_KEY` from `wrangler.jsonc` `vars` block
**Description:** As the operator, I want secret bindings to live in `wrangler secret put` only so the next deployer cannot accidentally commit a live key.

**Source:** Server S4.

**Acceptance Criteria:**
- [ ] `wrangler.jsonc` `vars` block does not declare `AUTUMN_SECRET_KEY`.
- [ ] README documents `AUTUMN_SECRET_KEY` only via `wrangler secret put`, consistent with other secret bindings.
- [ ] Boot/health check (or deploy script) fails loudly if `AUTUMN_SECRET_KEY` is unset in production.
- [ ] Regression test: deploy lint/check script fails when `AUTUMN_SECRET_KEY` appears in `vars`.
- [ ] Typecheck and lint pass.

#### US-013: Lock down dev-login route and remove fallback secret
**Description:** As the operator, I want a default `wrangler deploy` to never expose the dev-login route or a hardcoded session secret.

**Source:** Server S5 (compounding S3 + S4).

**Acceptance Criteria:**
- [ ] Hardcoded `'dev-secret-key-32-chars-long!!'` fallback removed; route returns 500 if `SESSION_SECRET` is missing.
- [ ] Default `NODE_ENV` is treated as `production` when unset (or boot fails fast if missing).
- [ ] `/api/auth/dev-login` is additionally gated by request hostname being `127.0.0.1` or `localhost` (defense in depth on top of the env check).
- [ ] Regression test: `POST /api/auth/dev-login` to non-loopback hostname returns 403 even if `NODE_ENV` is misconfigured.
- [ ] Regression test: missing `SESSION_SECRET` causes 500 from dev-login (not silent acceptance).
- [ ] Typecheck and lint pass.

---

### P1 — significant correctness/security risk

#### US-014: Force-pull skipped rows after their outbox row clears
**Description:** As a user whose feed had a pending outbox write during sync, I want the eventual server-side update (description re-parsed, `last_fetched`, etc.) to land in my local DB after the outbox drains.

**Source:** Client P1-1.

**Acceptance Criteria:**
- [ ] `setLastPullAt` is not advanced past skipped rows, OR a per-row "needs-pull-after-clear" flag triggers a targeted re-pull when the outbox row is removed.
- [ ] Regression test: queue an outbox `update_item`; pull sync arrives with a server change to the same item; outbox drains; subsequent pull lands the server change.
- [ ] Typecheck and lint pass.

#### US-015: Serialize concurrent `runSync` invocations via promise mutex
**Description:** As the sync subsystem, I want concurrent `runSync` triggers (auth effect + `online` event + manual) coalesced into a single in-flight cycle so I do not double-issue HTTP requests or fail BEGIN-within-BEGIN.

**Source:** Client P1-2.

**Acceptance Criteria:**
- [ ] Per-DB `Promise` mutex around `runSync`; concurrent callers receive the same in-flight promise.
- [ ] No "cannot start a transaction within a transaction" SQLite error from concurrent triggers.
- [ ] No duplicate HTTP requests for the same `client_op_id`.
- [ ] Regression test: invoke `runSync` twice in parallel; assert exactly one push and one pull HTTP exchange.
- [ ] Typecheck and lint pass.

#### US-016: Gate `online` event handler on `isLocalFirstActive`
**Description:** As the sync subsystem, I want to skip work when the user has disabled local-first so I do not push/pull against a DB that is about to be wiped.

**Source:** Client P1-3.

**Acceptance Criteria:**
- [ ] `handleOnline` returns early when `!isLocalFirstActive.value`.
- [ ] Regression test: toggle local-first off, dispatch `online` event, assert no `runSync` was triggered.
- [ ] Typecheck and lint pass.

#### US-017: Rewrite outbox `delete_feed` target_id when its `add_feed` reconciles
**Description:** As a user who adds and immediately deletes a feed offline, I want the delete to apply against the canonical server id, not the optimistic local id.

**Source:** Client P1-4.

**Acceptance Criteria:**
- [ ] On `add_feed` 2xx reconcile, scan outbox for `delete_feed` rows with `target_id === <old_local_id>` and rewrite to `target_id = <new_server_id>`.
- [ ] Regression test: enqueue `add_feed` then `delete_feed` for the same optimistic id, drain push, assert server receives `DELETE /api/feeds/<server_id>` (not `<old_local_id>`) and final state has no orphan feed.
- [ ] Typecheck and lint pass.

#### US-018: Tie-break equal-timestamp `update_item` writes
**Description:** As the LWW conflict resolver, I want a stable secondary order so two updates within the same millisecond do not produce ambiguous resolution.

**Source:** Client P1-5.

**Acceptance Criteria:**
- [ ] Either: append a monotonic counter to `client_updated_at`, or document the resolution rule and enforce it in both client and server LWW logic.
- [ ] Regression test: two `updateItem` calls in the same tick produce deterministic post-sync state on the server.
- [ ] Typecheck and lint pass.

#### US-019: Document and test the push-then-pull invariant for mark-all-read
**Description:** As the sync subsystem, I want the push-then-pull ordering invariant explicit and tested so a future refactor cannot silently break the mark-all-read offline flow.

**Source:** Client P1-6.

**Acceptance Criteria:**
- [ ] `sync.ts` and `pull-sync.ts` carry a one-line comment naming the invariant: `getPendingOutboxRefs` is called *after* `pushSync` resolves.
- [ ] Regression test for "mark_all_read offline → server has new items → come online → drain push → pull" sequence — new items end up visible (not silently skipped).
- [ ] Typecheck and lint pass.

#### US-020: Differentiate transient vs permanent push failures in attempt-cap logic
**Description:** As the outbox drain loop, I want 5xx blips not to consume the dead-letter budget so a brief server outage does not permanently drop user writes.

**Source:** Client P1-7.

**Acceptance Criteria:**
- [ ] 5xx → exponential backoff with attempt counter reset on success.
- [ ] 4xx (other than 401/402/409) → immediate dead-letter.
- [ ] 401/402 continue to throw out of the loop unchanged.
- [ ] Regression test: simulate 10 sequential 5xx then 1 success — outbox row drains; the row is not in dead-letter.
- [ ] Regression test: simulate one 400 — outbox row goes to dead-letter immediately.
- [ ] Typecheck and lint pass.

#### US-021: Probe storage quota before bootstrap; surface low-storage warning
**Description:** As a user on a low-storage device, I want to be warned before bootstrap starts writing a 50,000-item DB I cannot fit.

**Source:** Client P1-8.

**Acceptance Criteria:**
- [ ] Before `bootstrapLocalDb` writes any rows, call `navigator.storage.estimate()`.
- [ ] If `quota - usage < 100 MB` (configurable constant), surface a warning signal and require explicit user confirmation to proceed.
- [ ] Regression test: mock `storage.estimate` returning low free space; assert bootstrap does not proceed without explicit confirmation.
- [ ] Typecheck and lint pass.

#### US-022: Make `disableLocalFirst` cancel-safe for in-flight sync
**Description:** As a user toggling local-first off, I do not want a UI error flash from a sync that is mid-fetch when I toggle.

**Source:** Client P1-9.

**Acceptance Criteria:**
- [ ] `disableLocalFirst` sets a "disable in progress" flag that `runSync` checks at entry and at await boundaries (or uses an `AbortController`).
- [ ] In-flight sync aborts cleanly without `setSyncError`.
- [ ] OPFS file removal does not race with re-open by an in-flight sync.
- [ ] Regression test: trigger a sync that hangs on a fetch, call `disableLocalFirst`, assert no `setSyncError` is called and OPFS file is removed exactly once.
- [ ] Typecheck and lint pass.

#### US-023: Defer `setSyncSubscriptions(true)` until billing status loads
**Description:** As a user opening Settings before `loadBillingStatus` resolves, I want my toggle to apply once billing status arrives, not silently no-op.

**Source:** Client P1-10.

**Acceptance Criteria:**
- [ ] When `billingStatus.value === null`, the toggle either shows a loading state or queues the change and applies once `loadBillingStatus` resolves.
- [ ] No silent no-op when billing status is still loading.
- [ ] Regression test: open settings before billing resolves, toggle on, await billing load, assert `syncSubscriptions === true`.
- [ ] Typecheck and lint pass.

#### US-024: Harden SSRF defense — IP-aware blocklist + manual redirects
**Description:** As the operator, I want feed-fetch to block private/internal addresses by their resolved IP and refuse to follow redirects to them, defeating DNS rebinding and numeric-IP encoding tricks.

**Source:** Server S6, S7.

**Acceptance Criteria:**
- [ ] `validateFeedUrl` parses hostname into an IP (when applicable) and rejects RFC1918, link-local (`169.254/16`), unique-local (`fc00::/7`), IPv6 link-local (`fe80::/10`), IPv4-mapped (`::ffff:127.0.0.1`), and `[::]`.
- [ ] Numeric encodings (`http://2130706433/`, `http://0177.0.0.1/`, `http://0x7f.0.0.1/`) are rejected via canonical IP comparison.
- [ ] `fetchFeedText` sets `redirect: 'manual'`, follows at most 3 redirects, and re-validates each location header.
- [ ] DNS-over-HTTPS pre-resolution (or platform equivalent) re-checks the resolved IP immediately before fetch.
- [ ] Regression test covers each blocked encoding form and a redirect chain ending at a private IP.
- [ ] Typecheck and lint pass.

#### US-025: Cap hostile XML in feed parser
**Description:** As the feed-fetch subsystem, I want hostile or oversized feeds bounded so a single bad publisher cannot stall the alarm or fill SQLite with a 4 MB row.

**Source:** Server S8.

**Acceptance Criteria:**
- [ ] `parsedFeed.items.length` capped at 1000 before insertion; excess truncated and `last_error` records "feed too large".
- [ ] Per-field caps: `content` ≤ 1 MB, `description` ≤ 64 KB, `title` ≤ 8 KB.
- [ ] Insert errors no longer blanket-swallowed (see US-027).
- [ ] Regression test feeds: 5000-item feed → only 1000 inserted; 4 MB content field → truncated to 1 MB.
- [ ] Typecheck and lint pass.

#### US-026: Make alarm reschedule survive mid-refresh kill
**Description:** As the operator, I want the next alarm always scheduled even when the current alarm is killed by the CPU budget mid-work.

**Source:** Server S9.

**Acceptance Criteria:**
- [ ] Alarm schedules `next` at the start (or in a `try/finally`), not after refresh completion.
- [ ] If the alarm runs out of budget, refresh resumes from where it left off on the next alarm via batch tracking in DO storage.
- [ ] Regression test: simulate alarm kill mid-refresh; assert next alarm is still scheduled and the remaining feeds are processed on it.
- [ ] Typecheck and lint pass.

#### US-027: Stop swallowing INSERT errors in feed parser
**Description:** As the operator, I want non-duplicate-key INSERT failures observable so a user with a broken feed sees an error instead of "no new items forever".

**Source:** Server S17 (related to S8).

**Acceptance Criteria:**
- [ ] The `catch` block distinguishes SQLite duplicate-key (ignorable) from other errors (logged + recorded in feed `last_error`).
- [ ] Regression test: simulated row-too-big INSERT records `last_error` on the feed row instead of being swallowed.
- [ ] Typecheck and lint pass.

#### US-028: Strengthen CSRF check beyond `Sec-Fetch-Site` heuristics
**Description:** As the operator, I want state-changing routes refused when the request lacks both `Origin` and `Sec-Fetch-Site`, with a CSRF token as defense in depth.

**Source:** Server S10.

**Acceptance Criteria:**
- [ ] `isCrossOriginStateChange` rejects any state-changing method (POST/PATCH/DELETE/PUT) that lacks both `Origin` AND `Sec-Fetch-Site`.
- [ ] CSRF token issued in a header-readable cookie at session creation, required as `X-CSRF-Token` echo on state-changing routes.
- [ ] `APP_ORIGIN` is required at boot; missing config fails closed.
- [ ] Regression test: state-changing request with missing both headers → 403; valid CSRF token round-trip → 200.
- [ ] Typecheck and lint pass.

#### US-029: Audit `withIsolationHeaders` content-type gating and document COEP `credentialless`
**Description:** As a reviewer, I want explicit test coverage and inline documentation for the `credentialless` cookie-stripping behavior on cross-origin subresources.

**Source:** Server S11.

**Acceptance Criteria:**
- [ ] Inline comment explains `credentialless` choice and the cookie-stripping consequence for third-party feed thumbnails.
- [ ] Regression test: cross-origin image fetch verifies the COEP behavior matches expectation (no auth cookies sent).
- [ ] Typecheck and lint pass.

#### US-030: Tighten CORS allowlist and require `APP_ORIGIN` at boot
**Description:** As the operator, I want the CORS allowlist to never silently fall back to a hardcoded production origin in a misconfigured deploy.

**Source:** Server S12.

**Acceptance Criteria:**
- [ ] Boot fails when `APP_ORIGIN` is unset (no `DEFAULT_APP_ORIGIN` fallback at runtime).
- [ ] `allowedCorsOrigin` echoes `origin` only when `origin === c.env.APP_ORIGIN`.
- [ ] Regression test: missing `APP_ORIGIN` env causes boot/health-check failure.
- [ ] Regression test: cross-origin request from a non-allowlisted origin → no `Access-Control-Allow-Origin` echoed.
- [ ] Typecheck and lint pass.

#### US-031: Validate session record shape after KV JSON.parse
**Description:** As the auth middleware, I want a corrupted KV session record rejected loudly instead of producing an undefined `did` downstream.

**Source:** Server S13.

**Acceptance Criteria:**
- [ ] `verifySessionCookie` validates `typeof record.session === 'object' && typeof record.session.did === 'string' && typeof record.session.handle === 'string'` before returning.
- [ ] Malformed records cause cookie destruction and a 401, not a downstream crash.
- [ ] Regression test: write a malformed `session:<sid>` KV record; assert 401 plus cookie cleared.
- [ ] Typecheck and lint pass.

#### US-032: Normalize feed URLs for idempotency
**Description:** As a user adding the same feed twice with different casing or trailing slash, I want the server to deduplicate them.

**Source:** Server S14.

**Acceptance Criteria:**
- [ ] `validateFeedUrl` canonicalizes: lowercase host, strip trailing slash on path-root, lowercase scheme (already done by URL).
- [ ] DO `add_feed` lookup uses the canonical form.
- [ ] Regression test: `https://Example.COM/feed/` and `https://example.com/feed` resolve to the same row.
- [ ] Typecheck and lint pass.

#### US-033: Clamp `client_updated_at` server-side to defeat client clock spoofing
**Description:** As the LWW conflict resolver, I want client-supplied timestamps clamped to a sane upper bound so a buggy or malicious client cannot pin itself to win every conflict.

**Source:** Server S15.

**Acceptance Criteria:**
- [ ] `client_updated_at` server-side is clamped: `min(client_updated_at, now() + 5min)`.
- [ ] When clamping triggers, log the event for observability.
- [ ] Regression test: client sends `client_updated_at: '9999-12-31T23:59:59'`; server stores and uses the clamped value, not the client's.
- [ ] Typecheck and lint pass.

#### US-034: Per-feed rate limit on `/feeds/:id/refresh`
**Description:** As the operator, I want manual refresh capped so an authenticated user cannot turn the service into a DOS amplifier against third-party publishers.

**Source:** Server S18.

**Acceptance Criteria:**
- [ ] DO storage tracks `last_manual_refresh_at` per feed; `fetchFeed` is no-op (or 429) if called within 60 seconds of the previous manual refresh.
- [ ] Regression test: 100 rapid `POST /api/feeds/:id/refresh` calls trigger only one outbound `fetchFeed`.
- [ ] Typecheck and lint pass.

#### US-035: Send subscription emails to Autumn-verified addresses, not user-submitted
**Description:** As the operator, I do not want logged-in users to send RSSS-branded emails to arbitrary recipients.

**Source:** Server S19.

**Acceptance Criteria:**
- [ ] `sendSubscriptionStarted` and related email triggers use the email Autumn has on file (`customer.email`), never the request body's `email` field.
- [ ] `stashPendingEmail` continues to record what email Autumn should bind, but is not the recipient source.
- [ ] Regression test: `POST /api/billing/checkout` with `body.email = 'attacker@example.com'` does not result in an email being sent to that address.
- [ ] Typecheck and lint pass.

#### US-036: Drop GET `/logout`
**Description:** As a user, I do not want a stray `<img src="/logout">` or pre-fetcher to log me out.

**Source:** Server S20.

**Acceptance Criteria:**
- [ ] GET `/logout` handler removed (or returns 405).
- [ ] All client logout call sites use `POST /api/auth/logout`.
- [ ] Regression test: `GET /logout` returns 405 (or 404); `POST /api/auth/logout` continues to work.
- [ ] Typecheck and lint pass.

#### US-037: Forward only the headers the DO needs
**Description:** As the worker proxying to the DO, I want to drop client-supplied `Authorization` and other unnecessary headers so a future DO route cannot become a confused deputy.

**Source:** Server S31 (P2 — included as defense-in-depth alongside US-009).

**Acceptance Criteria:**
- [ ] `dataRouter` constructs the DO request with an explicit allowlist of headers (`Content-Type`, RSSS custom headers, `cookie` if needed). All other client headers stripped.
- [ ] Regression test: client `Authorization: Bearer xyz` is not present on the request the DO sees.
- [ ] Typecheck and lint pass.

---

### Test coverage track (separate from fix stories)

Each fix story above carries its own regression test. The stories below address structural CI gaps and missing scenarios documented in the client review's TC-1..TC-11 section.

#### US-038: Wire all client-side test files into `npm test`
**Description:** As a maintainer, I want `npm test` to actually exercise push-sync, pull-sync, bootstrap, local-adapter, adapter-factory, tab-coordination, and local-first-settings so a green checkmark reflects real coverage.

**Source:** TC-1, TC-11.

**Acceptance Criteria:**
- [ ] Every test file under `test/` that exercises a high-risk client module is reachable via either `test/index.ts` imports or `test/run-all-tests.mjs` script entries.
- [ ] `npm test` invokes all of the following: tab-coordination, pull-sync, push-sync, bootstrap, local-adapter, adapter-factory, sqlite-init, local-first.
- [ ] Wa-sqlite tests (`--loader:.wasm=dataurl`) run as part of `npm test`, not only when explicitly invoked.
- [ ] Regression: a deliberate failure in any of those test files causes `npm test` to fail.
- [ ] Typecheck and lint pass.

#### US-039: Test bootstrap interruption and resumption
**Description:** As a maintainer, I want regression tests for the catastrophic recovery path so US-002's behavior cannot silently regress.

**Source:** TC-2.

**Acceptance Criteria:**
- [ ] Test: network error mid-bootstrap leaves no OPFS file behind in the terminal-error path.
- [ ] Test: user can re-toggle and re-bootstrap after a transient failure (no auto-disable).
- [ ] Test: bootstrap with a partial outbox already present (a reset+bootstrap with leftover outbox rows) completes cleanly.
- [ ] Typecheck and lint pass.

#### US-040: Test dead-letter outbox path
**Description:** As a maintainer, I want regression tests asserting the attempt-cap behavior, so US-020 cannot silently regress.

**Source:** TC-3.

**Acceptance Criteria:**
- [ ] Test: after the configured number of failures, a row moves to `dead_letter_outbox`.
- [ ] Test: `setSyncDone` payload includes `deadLetters` count.
- [ ] Test: a row in `dead_letter_outbox` is not retried.
- [ ] Typecheck and lint pass.

#### US-041: Test `add_feed` reconcile cascade with attached items
**Description:** As a maintainer, I want a test that asserts user item state survives `add_feed` reconcile when the optimistic feed already has attached items.

**Source:** TC-4 (paired with US-003).

**Acceptance Criteria:**
- [ ] Test: optimistic feed with two items (one read, one starred) reconciles via push 2xx; both items reappear under the canonical feed id with their flags intact.
- [ ] Typecheck and lint pass.

#### US-042: Test clock skew and timestamp format mismatches
**Description:** As a maintainer, I want a test that fails if the timestamp formats diverge across `last_pull_at` write and `WHERE updated_at > ?` read.

**Source:** TC-5 (paired with US-005).

**Acceptance Criteria:**
- [ ] Test: server sends `latestUpdatedAt = '2026-04-25 10:00:00'`; client writes a feed locally; next pull's `since` does not skip the local write.
- [ ] Typecheck and lint pass.

#### US-043: Test concurrent `runSync` invocations
**Description:** As a maintainer, I want a test that fails if the `runSync` mutex is removed.

**Source:** TC-6 (paired with US-015).

**Acceptance Criteria:**
- [ ] Test: two `runSync(db)` calls in parallel produce exactly one push HTTP exchange and one pull HTTP exchange.
- [ ] Test: SQLite "cannot start a transaction within a transaction" never occurs under concurrent invocation.
- [ ] Typecheck and lint pass.

#### US-044: Test `disableLocalFirst` while a sync is in flight
**Description:** As a maintainer, I want a test that fails if a user-visible error flashes from a cancelled sync.

**Source:** TC-7 (paired with US-022).

**Acceptance Criteria:**
- [ ] Test: start a sync that hangs on `fetch`; call `disableLocalFirst`; assert no `setSyncError` was invoked.
- [ ] Test: OPFS file is removed exactly once (no race with in-flight worker open).
- [ ] Typecheck and lint pass.

#### US-045: Test `online` event during a sync
**Description:** As a maintainer, I want a test that exercises the re-entrant `handleOnline` path so US-016 does not silently regress.

**Source:** TC-8 (paired with US-016).

**Acceptance Criteria:**
- [ ] Test: dispatch `online` event while a sync is already in flight; assert second sync is coalesced (not duplicated).
- [ ] Test: dispatch `online` event with `isLocalFirstActive === false`; assert no sync is triggered.
- [ ] Typecheck and lint pass.

#### US-046: Test storage quota exceeded path
**Description:** As a maintainer, I want a test that exercises `classifyLocalDbError`'s `'quota'` branch.

**Source:** TC-9.

**Acceptance Criteria:**
- [ ] Test: mock SQLite write throwing QuotaExceededError; assert the error is classified as `'quota'`.
- [ ] Test: bootstrap path and steady-state path both surface the quota error to the UI signal (not swallowed).
- [ ] Typecheck and lint pass.

#### US-047: Test `runSync` errors surface to UI through `setSyncError`
**Description:** As a maintainer, I want an end-to-end test for the trackStatus plumbing so the half-and-half flow does not regress.

**Source:** TC-10 (paired with the trackStatus audit suggested in client P2-6).

**Acceptance Criteria:**
- [ ] Test: pullSync throws a network error; assert `setSyncError` is called once with the expected message.
- [ ] Test: pushSync throws a non-auth error; assert `setSyncError` is called once.
- [ ] Test: auth (401) and billing (402) errors continue to throw out of `runSync` rather than become silent setSyncError calls (or whatever the documented behavior is).
- [ ] Typecheck and lint pass.

#### US-048: Test the billing entitlement gate
**Description:** As a maintainer, I want a server-side test asserting unentitled sessions cannot reach `dataRouter` routes.

**Source:** New (paired with US-009; not in original TC list because the feature itself was missing).

**Acceptance Criteria:**
- [ ] Test: authenticated session with no Autumn entitlement → 402 from each `dataRouter` route.
- [ ] Test: authenticated session with active entitlement → 200/201/204 as appropriate.
- [ ] Test: NODE_ENV=production with missing Autumn config → 503 from `/api/billing/checkout` (paired with US-010).
- [ ] Typecheck and lint pass.

---

## Functional Requirements

- FR-1: Every `dataRouter` route requires both `requireAuth` and `requireEntitlement` middleware (US-009).
- FR-2: `/sync` paginates by `(updated_at, id)` cursor with a 500-row cap per page (US-001).
- FR-3: Bootstrap distinguishes transient from terminal errors and never auto-disables `syncSubscriptions` for transient errors (US-002).
- FR-4: `add_feed` reconcile preserves attached item `is_read`/`is_starred` state (US-003).
- FR-5: One timestamp format is used everywhere `updated_at` is written (US-005).
- FR-6: `navigator.locks.request` is the source of truth for OPFS primary-tab status (US-006).
- FR-7: Session cookie carries `Secure` outside loopback, regardless of `NODE_ENV` (US-011).
- FR-8: `wrangler.jsonc` carries no secrets in `vars` (US-012).
- FR-9: Dev-login route gated by `NODE_ENV === 'development'` AND loopback hostname; no fallback secret (US-013).
- FR-10: `requireEntitlement` returns 402 when `!isEntitled(billing)` (US-009).
- FR-11: SSRF defense rejects RFC1918, link-local, IPv6 link-local, IPv4-mapped, and numeric-IP encodings; manual redirects are validated; max 3 hops (US-024).
- FR-12: Feed parser caps items per feed at 1000, content at 1 MB, description at 64 KB, title at 8 KB (US-025).
- FR-13: Alarm schedules its successor before doing work, not after (US-026).
- FR-14: Push outbox attempt-cap distinguishes 5xx (retry) from non-auth 4xx (immediate dead-letter) (US-020).
- FR-15: `runSync` invocations are coalesced per-DB via a promise mutex (US-015).
- FR-16: `client_updated_at` is clamped server-side to `now() + 5min` (US-033).
- FR-17: `sendSubscriptionStarted` recipient is the Autumn-verified email, not request body (US-035).
- FR-18: GET `/logout` does not exist (US-036).
- FR-19: `npm test` invokes every high-risk client test file plus the wa-sqlite integration tests (US-038).

## Non-Goals

- This PRD does **not** address P2 or P3 nits from either review (style, comment drift, dead code, doc edits, README wording corrections like "encrypted" vs "signed cookies"). Those are deliberately out of scope for the launch-blocking work.
- This PRD does **not** introduce Autumn webhook-driven entitlement changes (server S22). Polling remains the design.
- This PRD does **not** redesign the outbox protocol; it only patches the specific issues called out.
- This PRD does **not** introduce Sentry / structured error tracking (server S23).
- This PRD does **not** rotate the `client_id` registered with Bluesky or change the OAuth flow shape beyond the session-validation tightening in US-031.
- This PRD does **not** address `state.ts` size growth (P3-10) or other refactor-only nits.

## Technical Considerations

- Two cross-stack stories (US-001 sync pagination, US-009 billing gate) require coordinated client + server changes; sequence them so the server lands first behind a feature flag, then the client switches over.
- US-006 (Web Locks API) replaces the BroadcastChannel coordination primitive; existing tests in `test/tab-coordination.ts` will need to be retargeted.
- US-013 changes deploy semantics — coordinate with whoever owns the deploy runbook before merging, since a green deploy that previously worked will start failing if `SESSION_SECRET` or `NODE_ENV` aren't set.
- US-024 SSRF tightening may require a DNS-over-HTTPS dependency; budget for a trusted resolver (Cloudflare 1.1.1.1 DoH is appropriate given the platform).
- Many fix stories require `npm test` to actually run their regression tests; US-038 must land first or in lockstep with the fix stories so the tests can be authored against a working CI surface.
- The CSRF token in US-028 requires a small client change (echo `X-CSRF-Token` from a cookie) — keep the change tightly scoped; avoid touching the OAuth flow.

## Success Metrics

- Zero P0 findings remain at re-review.
- Zero P1 findings remain at re-review.
- `npm test` runs all client-side high-risk modules, with no skipped or quarantined files.
- A user with no Autumn entitlement receives 402 from every `dataRouter` route (verified by automated test).
- A default `wrangler deploy` produces a deployment with `Secure` cookies, no dev-login route, and no AUTUMN_SECRET_KEY in `vars`.
- Bootstrap of a 1500-item account succeeds without OOM in the DO, the worker, or the browser tab.
- A simulated feed publisher serving 50,000 `<item>` elements does not stall the alarm or fill SQLite.

## Open Questions

- Should US-001 stream items as NDJSON instead of paginated JSON pages? NDJSON is simpler to interrupt-and-resume but requires a streaming JSON parser on the client. Decide per implementer judgment; the acceptance criteria do not mandate either format.
- Should US-018's tie-break be a monotonic counter appended to the timestamp, or a separate `client_seq` column on the outbox? Implementer's choice; document in the migration.
- Should US-024 reject *all* private/special-use IPs, or only reject when public-egress would otherwise reach them? Workers' egress is already restricted in many cases — confirm CF's current guarantees and document the layered defense.
- US-013: should the loopback gate also accept `*.localhost` or `*.local`? Pick one and document.
- The dead-letter outbox UI surface (P2-9) is out of scope here, but the regression tests in US-040 will exercise the underlying behavior; future work needs a UI for inspection/retry.
