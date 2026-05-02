# Feature Specification: Fetch Full Article Body When Feed Provides Only a Summary

**Feature Branch**: `002-full-article-fetch`
**Created**: 2026-05-01
**Status**: Draft
**Input**: User description: "Why does the app GUI not have the full text of
the article? Is it a problem with the xml/feed or with my app? — Option 2:
fetch the full article on demand, and also show a link on the article page
after the description that says 'read the full article on xyz.com'."

## Background

Some publishers configure their RSS/Atom feeds to deliver only a short
summary of each post (a one-paragraph teaser in the `<description>` field)
rather than the full body of the article. The reader app correctly extracts
whatever the feed provides — preferring `content:encoded` when present and
falling back to `<description>` — but for "summary-only" feeds there is
nothing more to show. The reader is left with one paragraph and a button
labelled "Open original" that takes them out of the app entirely.

The reader's experience today:

- They click into an item to read it, and the article view contains only
  one or two sentences.
- It is not obvious whether (a) the article is genuinely that short, (b)
  something failed during fetching, or (c) the publisher only ships a
  summary in the feed.
- To read the actual post they must leave the app and load the publisher's
  site in a new tab, losing reading position, dark-mode preference, and
  any "mark read" / "favourite" affordances the reader provides.

This feature gives the app a way to fetch the full article body on demand
when the feed provides only a summary, and to make the path back to the
publisher's site explicit and friendly when the reader prefers to read
there instead.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read a full article inside the reader even when the feed only ships a summary (Priority: P1)

As a reader subscribed to a feed whose items contain only a short summary,
I want to be able to read the full article body inside the reader app
without leaving for the publisher's site.

**Why this priority**: This is the core problem the user reported. Today the
reader is unusable for these feeds — every item shows one paragraph and the
only way to read the actual content is to leave the app. Solving this
restores the basic "read articles in your reader" promise for a large class
of feeds.

**Independent Test**: Subscribe to a feed that is known to provide only
summaries (e.g. brittanyellich.com/index.xml). Open one of its items in the
reader. Within a few seconds the reader displays the full article body in
the same article view, formatted readably (paragraphs, headings, inline
images, links).

**Acceptance Scenarios**:

1. **Given** an item from a summary-only feed and an open article view,
   **When** the reader opens that item, **Then** the reader shows the full
   article body fetched from the article URL, replacing or extending the
   short summary, without requiring the reader to leave the app.
2. **Given** an item whose feed already provides the full body in
   `content:encoded`, **When** the reader opens that item, **Then** the
   reader shows the body that was already in the feed and does NOT make any
   extra network request to the publisher's site (no behaviour change for
   feeds that already ship full content).
3. **Given** the reader is offline, **When** the reader opens a
   summary-only item that has not previously been fetched, **Then** the
   reader shows the summary that is already cached locally and indicates
   clearly that the full article cannot be fetched right now.
4. **Given** the publisher's site is unreachable or blocks the fetch,
   **When** the reader opens a summary-only item, **Then** the reader still
   shows the summary that came in the feed, indicates that the full article
   could not be retrieved, and offers a clear path to open the article on
   the publisher's site.

---

### User Story 2 - "Read the full article on xyz.com" link below the summary (Priority: P1)

As a reader, I want a clearly worded link directly below the article
content that takes me to the publisher's site, so that I can choose to
read or comment on the original page even when the in-app version is
adequate.

**Why this priority**: This was explicitly requested in the input. It also
serves as the graceful-degradation path for User Story 1 when full-body
fetching fails: the reader always has a clearly labelled escape hatch to
the publisher, named after the publisher itself rather than a generic
button.

**Independent Test**: Open any item in the reader. Below the article body
(or summary, if that is all the reader has) there is a link reading "Read
the full article on `<publisher-domain>`" where `<publisher-domain>` is
derived from the article URL. Clicking the link opens the article URL in a
new tab/window.

**Acceptance Scenarios**:

1. **Given** an open article view for an item whose link is
   `https://brittanyellich.com/i-guess-im-ai-pilled-now`, **When** the
   reader views the page, **Then** below the article body there is a link
   reading "Read the full article on brittanyellich.com" that points to
   that article URL.
2. **Given** an item whose link is on a subdomain (e.g.
   `https://blog.example.com/post/123`), **When** the reader views the
   article view, **Then** the link reads "Read the full article on
   blog.example.com" (the host as it appears in the link, with `www.`
   stripped if present).
3. **Given** an item that has no usable article URL, **When** the reader
   views the article view, **Then** no broken link is shown — the link is
   simply omitted.
4. **Given** the user clicks the link, **When** the browser opens it,
   **Then** the link opens in a new tab/window so the user does not lose
   their place in the reader.

---

### User Story 3 - The reader can tell, at a glance, that an item only had a summary (Priority: P2)

As a reader, when an item only had a summary in the feed, I want the
article view to make it clear whether I am looking at the publisher's full
text (fetched on my behalf) or only the summary that came through the feed.

**Why this priority**: Without this, the reader cannot tell whether they
have read the entire article. They may stop reading mid-piece thinking they
finished. This is a clarity/trust issue rather than a missing-functionality
issue, so it is P2 — User Story 1 is enough to be valuable on its own.

**Independent Test**: Open three items: (a) one whose feed shipped the full
body, (b) one whose feed shipped only a summary and was successfully
augmented by an on-demand fetch, and (c) one whose feed shipped only a
summary and whose on-demand fetch failed. The reader can visually
distinguish (b) and (c) from each other and from (a).

**Acceptance Scenarios**:

1. **Given** an item whose feed shipped the full body, **When** the reader
   opens it, **Then** no "summary only" notice is shown.
2. **Given** an item whose feed shipped only a summary and the on-demand
   fetch succeeded, **When** the reader opens it, **Then** the article
   view either shows the full body without any notice, or shows a small,
   non-alarming notice confirming the body was fetched from the publisher
   on the user's behalf.
3. **Given** an item whose feed shipped only a summary and the on-demand
   fetch failed (offline, blocked, parse failure), **When** the reader
   opens it, **Then** the article view clearly indicates that only the
   summary is available and the full article must be read on the
   publisher's site, with the link from User Story 2 immediately adjacent.

---

### Edge Cases

- **Paywalled or login-walled articles**: The fetched HTML may not contain
  the article body at all, or may contain a teaser plus a paywall message.
  The reader must not silently present a paywall stub as the full article;
  it should fall back to the summary plus the explicit publisher link.
- **Articles behind redirects**: The article URL may redirect several
  times before reaching the readable HTML. Handling must be consistent
  with the redirect behaviour already established for thumbnail
  enrichment in spec 001.
- **Very large articles**: A fetched HTML page can be hundreds of
  kilobytes after extraction. The reader must cap how much is stored per
  item to keep the local database from growing unbounded.
- **Non-HTML responses**: The article URL may resolve to a PDF, video, or
  other non-HTML resource. In those cases the reader must not attempt to
  extract a body — it should keep the summary and show the publisher
  link.
- **Repeat opens**: The same item can be opened many times. The on-demand
  fetch should happen at most once per item under normal conditions; the
  fetched body is reused on subsequent opens.
- **Manual refresh**: The reader may want to retry a previously failed
  fetch (e.g. after coming back online). There must be a way to trigger a
  retry without resubscribing to the feed.
- **Privacy / tracking**: Fetching an article URL may expose the reader's
  IP and request headers to the publisher. The fetch should originate
  server-side so the reader's browser does not directly contact the
  publisher merely by opening an item.
- **Adversarial publisher content**: The fetched HTML may contain
  scripts, tracking pixels, or malformed markup. Anything inserted into
  the article view must be sanitised so the reader app's security
  posture is preserved.

## Requirements *(mandatory)*

### Functional Requirements

#### On-demand full-article fetching

- **FR-001**: The reader MUST detect, for each opened item, whether the
  body it has locally (the original feed content) is plausibly only a
  summary versus a full article. The detection MUST be deterministic and
  testable from item data alone (no model calls).
- **FR-002**: When an item is detected as summary-only and the reader is
  online, the reader MUST request the full article body from the article
  URL on the user's behalf, server-side, and present the extracted
  readable body in the article view.
- **FR-003**: The reader MUST NOT trigger an on-demand article fetch for
  items whose feed already delivered a full body (i.e. items whose
  detection in FR-001 says "this is already the full article").
- **FR-004**: On-demand article fetches MUST happen only when the user
  opens an item, not as part of the routine feed refresh. The feed
  refresh path MUST remain unchanged in scope and cost. (The reader
  already locked down automatic refresh paths in US-144; this feature
  must not reintroduce one.)
- **FR-005**: An extracted article body MUST be cached against the item
  so that re-opening the item later does not re-fetch the publisher's
  site under normal conditions.
- **FR-006**: The reader MUST sanitise any fetched HTML before rendering
  it in the article view (strip scripts, inline event handlers, unsafe
  URLs) using the same sanitisation pipeline already applied to feed
  content.
- **FR-007**: The reader MUST cap the size of the stored extracted body
  per item to a reasonable upper bound and MUST gracefully handle
  responses that would exceed it (truncate at a paragraph boundary or
  fall back to the summary).
- **FR-008**: If the fetch fails for any reason (network error, non-HTML
  response, unreachable host, redirect loop, paywall detected, body
  extraction returned nothing usable), the reader MUST fall back to the
  feed-supplied summary and clearly indicate that the full article could
  not be retrieved.
- **FR-009**: The reader MUST offer a way for the user to retry a
  previously failed on-demand fetch without resubscribing or fully
  refreshing the feed.
- **FR-010**: Server-side fetch behaviour for article URLs MUST be
  consistent with the redirect, timeout, and error-classification rules
  already established for thumbnail enrichment in spec 001 (so that a
  reader operator does not see a new wave of alarming red log lines for
  routine article-page redirects).

#### "Read the full article on …" link

- **FR-011**: The article view MUST display a link immediately below the
  article body labelled "Read the full article on `<publisher-domain>`"
  whenever the item has a non-empty article URL.
- **FR-012**: The publisher domain shown in the link label MUST be
  derived from the article URL's host, with a leading `www.` removed if
  present. The full URL (not the displayed label) MUST be used as the
  link target.
- **FR-013**: The link MUST open the publisher's article in a new tab or
  window so the user does not lose reading position in the reader app.
- **FR-014**: The link MUST be present whether the body shown is the
  feed summary, an on-demand-fetched full body, or a fallback after a
  failed fetch — it is always the explicit escape hatch to the
  publisher.
- **FR-015**: If an item has no article URL at all, the link MUST be
  omitted (the article view MUST NOT render a broken or empty link).

### Key Entities

- **Item**: A single feed entry the reader has stored locally. Already
  carries title, summary/body, link, publication date, etc. This feature
  adds the ability to associate an item with a separately fetched "full
  article body" and a small amount of metadata describing where that
  body came from and when it was fetched.
- **Full Article Body**: The readable text/HTML extracted from the
  article URL on the user's behalf, after sanitisation and size capping.
  Conceptually owned by the item. Replaces or augments the in-feed
  summary when present.
- **Fetch Status (per item)**: A small piece of state describing the
  outcome of the most recent on-demand fetch attempt for the item:
  e.g. "not attempted", "succeeded", "failed (network)", "failed
  (paywall / no body extracted)", with a timestamp. Used to drive both
  the UI indicator (User Story 3) and the retry affordance (FR-009).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a feed that ships only summaries (e.g. an Astro/Jekyll
  blog whose RSS contains only `<description>`), at least 90% of items
  opened by the user successfully render a full article body inside the
  reader on the first open, when the user is online and the publisher's
  site is reachable.
- **SC-002**: When the reader opens a summary-only item while online,
  the full article body appears within 3 seconds of opening on a typical
  consumer broadband connection.
- **SC-003**: Reopening an item that previously rendered its full
  article body shows the same body without producing any additional
  network request to the publisher's site.
- **SC-004**: Across all items in the reader, the "Read the full article
  on …" link is present and points to the correct publisher domain in
  100% of cases where the item has an article URL, and is absent in
  100% of cases where it does not.
- **SC-005**: When the on-demand fetch fails, the reader still shows
  the feed-supplied summary plus the explicit publisher link in 100% of
  cases — there is no state in which the reader presents an empty
  article view because of a failed fetch.
- **SC-006**: The user can visually distinguish a fully-fetched article
  view from a summary-only fallback view in 100% of cases (the
  fallback state is clearly labelled).
- **SC-007**: Routine "refresh feeds" operations are not slower or
  costlier (in network requests per refresh) after this feature ships
  than before — on-demand fetching adds no per-feed-refresh cost.
- **SC-008**: Stored full article bodies do not cause the reader's
  local database to grow without bound: per-item storage for an
  extracted body is bounded by a fixed cap.

## Assumptions

- The existing feed parser already prefers `content:encoded` over
  `<description>` and falls back correctly; this feature does not
  change that behaviour, it only adds a third tier (on-demand fetch
  from the article URL) when neither yields a full body.
- Most publishers serve readable HTML at the article URL even when
  their RSS only ships a summary. Publishers that block bots, require
  authentication, or serve only paywall stubs are explicitly handled
  via the fallback path (FR-008 / SC-005) rather than treated as bugs.
- Server-side fetching is the right place for this work. The reader
  already fetches article URLs server-side for thumbnail enrichment
  (spec 001), and going server-side is necessary both for IP/header
  privacy (edge case above) and to reuse the redirect/timeout rules
  already established.
- The body-extraction approach (e.g. a Readability-style heuristic) is
  an implementation detail to be settled in `/speckit.plan` — the spec
  does not pin a specific library or algorithm.
- "Summary vs full body" detection is heuristic, not perfect. A short
  legitimately-tiny post will be treated as a summary and trigger one
  on-demand fetch on first open; this is acceptable.
- The reader's existing local-first storage model (items stored in
  IndexedDB / SQLite-WASM client-side, with server-side mirror) is
  retained. Where the extracted body is persisted (client, server, or
  both) is an implementation detail for `/speckit.plan`.
- Out of scope for this feature: re-fetching all previously stored
  items in bulk, OPML-level "always fetch full article" preferences,
  per-feed configuration of the fetch behaviour, and offline pre-fetch
  of full bodies. Those can be follow-up features once the on-demand
  flow is in place.
