# Feature Specification: Fix "Redirected Too Many Times" Errors During Feed Refresh

**Feature Branch**: `001-fix-og-image-redirects`
**Created**: 2026-04-30
**Status**: Draft
**Input**: User description: "I'm seeing a server-side error 'redirected too many times' [Image #3] This is after I click 'refresh feeds' button in the GUI."

## Background

When a reader clicks the "refresh feeds" button in the web UI, the server
fetches each subscribed feed, inserts any new items, and then tries to
fetch each new item's article URL to extract an OpenGraph image for use as
a thumbnail. Some article URLs follow several redirect hops (mobile/desktop,
www-canonicalization, http-to-https, tracking redirects, etc.). The current
server logic gives up after a small number of redirect hops and surfaces an
error labelled "Feed redirected too many times" — even though the URL being
followed is an article page, not the RSS feed itself.

The reader experience this produces:

- The server-side log fills up with red `Error` lines on every refresh.
- Some new items appear without thumbnails when their article URLs have
  legitimate redirect chains.
- The error message is confusing: it says "Feed redirected too many times"
  for what is really an article-page redirect during thumbnail enrichment.

The feed itself was actually fetched and parsed successfully — only the
optional thumbnail enrichment step is failing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Quiet, successful "refresh feeds" (Priority: P1)

As a reader who is also watching the server logs (developer or operator),
when I click "refresh feeds" I want the operation to complete without
producing alarming red error output for routine, expected behaviour like
article pages that redirect a few times.

**Why this priority**: This is the user-reported symptom. Today every refresh
produces multiple "Error fetching og image …: FeedFetchError: Feed redirected
too many times" entries that look like a real bug. They drown out genuine
errors and erode trust that the refresh actually worked.

**Independent Test**: Subscribe to a feed whose recent items link to article
pages that perform multiple redirect hops (e.g. a blog with an http→https
redirect and a www-canonicalization redirect). Click "refresh feeds" and
observe the server log: it must not contain "redirected too many times"
errors for routine article URLs. The refresh must still report success and
the new items must appear in the UI.

**Acceptance Scenarios**:

1. **Given** a subscribed feed whose new article URLs each follow up to 5
   ordinary HTTP redirects to reach a reachable article page, **When** the
   reader clicks "refresh feeds", **Then** the server completes the refresh
   without logging any "redirected too many times" error for those URLs and
   the new items appear in the reader's list.
2. **Given** a subscribed feed where one article URL is genuinely caught in a
   redirect loop (or exceeds the new, larger redirect budget), **When** the
   reader clicks "refresh feeds", **Then** the refresh still succeeds for
   every other article and the offending URL is handled quietly — it does
   not stop the rest of the refresh and it does not produce an alarming
   error-level log line.
3. **Given** the feed XML itself is behind too many redirects, **When** the
   reader clicks "refresh feeds", **Then** the system still surfaces a
   clear, accurate error against that one feed (this is a real failure that
   the user needs to know about) and other feeds continue to refresh.

---

### User Story 2 - Thumbnails load for articles with normal redirect chains (Priority: P2)

As a reader, I want new feed items to show their thumbnail image even when
the linked article page goes through several redirects before reaching the
final HTML.

**Why this priority**: Thumbnails are how the reader visually scans a long
list of new items. Today, items whose article URLs redirect more than a few
times silently land in the list with no thumbnail. The reader has no idea
this happened or why.

**Independent Test**: Add a feed whose latest item links to an article URL
that requires several redirect hops to reach the article HTML (e.g. a
shortened or syndicated link that ends at a real article). Refresh feeds.
The new item must appear with a thumbnail, drawn from the article's
OpenGraph image (or its feed-supplied image as a fallback).

**Acceptance Scenarios**:

1. **Given** a new feed item whose article link follows a typical real-world
   redirect chain (3–5 hops, ending at a normal article page), **When** the
   item is ingested by a feed refresh, **Then** the item is stored with a
   thumbnail derived from the article's OpenGraph image.
2. **Given** a new feed item whose article link cannot be resolved (genuine
   redirect loop, network failure, non-HTML response, missing OpenGraph
   tag), **When** the item is ingested, **Then** the item is still saved
   and displayed using whatever fallback thumbnail the feed itself provided
   — and if no fallback exists, the item is shown without a thumbnail
   instead of being dropped or marked as failed.

---

### Edge Cases

- An article URL that genuinely loops between two URLs forever — the system
  must give up after a bounded number of hops and move on, without spamming
  the log and without affecting other items in the same refresh.
- An article URL that redirects to a non-HTML resource (PDF, image, video).
  Thumbnail enrichment must skip it cleanly with no alarming log.
- An article URL that redirects to an internal/blocked address (loopback,
  link-local, RFC1918). The existing host-safety check must still reject it,
  and the rejection must continue to be quiet (it's expected, not an error).
- A feed that contains hundreds of new items at once. Thumbnail enrichment
  must remain bounded in time and must not block the refresh from completing
  or returning success to the UI.
- A feed whose own XML URL is behind too many redirects (the feed itself,
  not an article). This *is* a real error and must still be reported against
  that feed so the reader can see it in the feed's status.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When refreshing feeds, the system MUST distinguish between
  "fetching the feed XML" and "fetching an article page for thumbnail
  enrichment". Failures of the latter MUST NOT be reported with the same
  severity, message, or surface as failures of the former.
- **FR-002**: Thumbnail enrichment for new items MUST tolerate the redirect
  chains that real-world article URLs commonly use. The redirect budget for
  article-page fetches MUST be high enough that ordinary multi-hop chains
  (http→https, apex→www, locale or device redirects, syndicated link
  unwrapping) succeed. **Assumption**: a budget of at least 5 hops covers
  the overwhelming majority of legitimate cases; see Assumptions.
- **FR-003**: When thumbnail enrichment for a single article fails for any
  reason (too many redirects, network error, non-HTML, no OpenGraph tag,
  blocked host, timeout), the system MUST handle it quietly: the new item
  MUST still be saved, the refresh MUST continue for other items and other
  feeds, and the server log MUST NOT emit an error-level entry for the
  failure under normal operation.
- **FR-004**: Information about thumbnail-enrichment failures MAY be made
  available for debugging (e.g. behind a debug flag, at a non-error log
  level, or via an internal counter), but it MUST NOT appear as an
  error-level log line during a normal feed refresh.
- **FR-005**: When the feed XML itself fails to fetch — including the case
  where the feed URL exceeds its own redirect budget — the system MUST
  continue to record that failure against the feed (so the user sees the
  feed's last-error / last-status state in the UI) and MUST surface a
  message that accurately describes which URL the redirect limit applied to
  (the feed, not "Feed redirected too many times" emitted from an article
  fetch).
- **FR-006**: The "refresh feeds" action in the UI MUST report success to
  the reader whenever the feed XML was fetched and parsed successfully and
  new items were stored, regardless of whether thumbnail enrichment
  succeeded for every item.
- **FR-007**: A new feed item that has no successfully-resolved thumbnail
  MUST still be displayed in the reader's item list. The absence of a
  thumbnail MUST NOT cause the item to be hidden, retried indefinitely, or
  flagged as broken.

### Key Entities *(include if feature involves data)*

- **Feed**: A subscribed RSS/Atom source. Has a last-fetched time, a last
  error, and a last status. These reflect the state of fetching the *feed
  XML*, not the per-item thumbnail enrichment.
- **Item**: A single article inside a feed. Optionally has a thumbnail URL.
  An item with a missing thumbnail is still a valid item.
- **Thumbnail enrichment**: The best-effort process by which the server
  visits a new item's article URL to extract an OpenGraph (or equivalent)
  image. Treated as optional — its outcome does not change whether the item
  exists or whether the refresh succeeded.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After this change, a normal "refresh feeds" run across the
  reader's existing subscription list produces zero "redirected too many
  times" error-level log lines for article (thumbnail) fetches under
  ordinary conditions.
- **SC-002**: For a representative sample of feeds whose article links use
  common redirect patterns (http→https, apex→www, syndicated/wrapped
  links), at least 95% of newly-ingested items end up with a thumbnail
  after refresh — up from the current rate, where any chain longer than the
  current budget silently fails.
- **SC-003**: A "refresh feeds" operation that contains one item in a
  genuine redirect loop completes in approximately the same time as a
  refresh without that item, and other items in the same refresh are
  unaffected (no cascading delay or failure).
- **SC-004**: Genuine feed-level fetch failures (the feed XML itself can't
  be retrieved) continue to be visible to the reader on the corresponding
  feed in the UI — i.e. silencing the article-fetch noise must not also
  silence the failures the user actually needs to see.

## Assumptions

- A redirect budget of around 5 hops for article-page (thumbnail) fetches
  is sufficient to cover ordinary real-world redirect chains. Browsers
  typically allow ~20; we don't need to match them, but 3 is too low.
- Thumbnail enrichment is best-effort. The product does not require every
  item to have a thumbnail; missing thumbnails are an acceptable fallback.
- Server-side console output is read by developers/operators (not by the
  end reader). "Quiet" in this spec therefore means "does not log at the
  error level during normal operation"; structured low-severity diagnostics
  are still acceptable.
- The "refresh feeds" UI button calls an existing server endpoint that
  fetches every subscribed feed and waits for ingestion to settle before
  responding. This spec does not change the shape of that contract — only
  the noise and thumbnail-success behaviour underneath it.
- Existing host-safety rules (blocking loopback, link-local, RFC1918, etc.)
  remain in effect for both feed and article fetches and are not part of
  this change.
