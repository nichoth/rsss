# Feature Specification: Fix Flash of Unstyled Content on Page Refresh

**Feature Branch**: `015-fix-fouc-on-refresh`
**Created**: 2026-05-10
**Status**: Draft
**Input**: User description: "When I refresh the page, I get a big flash of
unstyled content. That didn't happen in the past. Need to fix that."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Refresh shows styled content immediately (Priority: P1)

A returning reader has the app open on the feed view. They reload the page
(via Cmd+R, browser refresh button, or by re-navigating to the URL). Instead
of seeing a brief moment where article titles render as default browser-styled
blue underlined links on a white background, the page paints with the app's
final styling on the first frame the user sees.

**Why this priority**: This is the entire feature. The visible flash is the
defect the user reported, it occurs on the most common interaction (refresh
of the primary feed view), and it materially degrades perceived quality and
trust. Without this fix the app feels broken on every page load.

**Independent Test**: With a warm browser cache and a cold browser cache,
load the feed view directly. Observe the very first painted frame (using a
screen recording or DevTools "Disable cache" + slow network throttle if
needed). The first frame must show app-styled content (the app's typography,
spacing, link colors, layout) and never the unstyled fallback shown in the
bug report screenshot.

**Acceptance Scenarios**:

1. **Given** the user is signed in and viewing the feed view, **When** they
   reload the page, **Then** every painted frame from the first paint onward
   shows the page rendered with the app's stylesheet applied (no period of
   browser-default blue underlined links over a white background).
2. **Given** the browser cache has been cleared, **When** the user loads the
   feed URL fresh, **Then** the first paint shows app-styled content (the
   stylesheet must be applied before, or simultaneously with, the first
   visible content).
3. **Given** the network is throttled (e.g. a slow 3G profile), **When** the
   user reloads the page, **Then** the user does not see a flash of unstyled
   content; if any visible content is shown before styles arrive, the page
   either keeps a blank/loading state or the inline critical styles cover it
   so the user never observes the unstyled fallback.
4. **Given** the user navigates via a hard reload (Cmd+Shift+R), **When** the
   page renders, **Then** there is no observable flash of unstyled content.

---

### User Story 2 - Other entry points are also FOUC-free (Priority: P2)

A user opens the app at a non-feed entry point (e.g. an article detail view
or any other top-level route reachable by direct URL) and reloads the page.
The fix is not specific to one route; the same guarantee applies to every
top-level route that users can refresh into.

**Why this priority**: The bug report is specifically about page refresh,
which can happen on any route. Fixing only the feed view would leave the
defect lurking on other entry points and would likely regress again the next
time the rendering pipeline changes. P2 because the feed view is the most
commonly refreshed surface and addressing it captures the bulk of the user
impact.

**Independent Test**: Repeat the User Story 1 test on each top-level route
the app exposes (article view, settings, etc., as applicable). Each route
must paint with app styling on the first visible frame after refresh.

**Acceptance Scenarios**:

1. **Given** the user is on a non-feed route, **When** they reload, **Then**
   the first paint is app-styled (no unstyled flash).
2. **Given** a deep link to any top-level route, **When** opened in a new tab
   from a cold cache, **Then** the first paint is app-styled.

---

### Edge Cases

- **Cold cache, slow network**: Stylesheet has not yet been downloaded when
  HTML arrives. The page must not display unstyled content while waiting; an
  acceptable behavior is to show no visible content (or a styled loading
  state) until styles are applied.
- **Stylesheet fails to load** (network error, ad blocker stripping a CDN):
  The page should still be readable, but this is a degraded-mode fallback
  and not what the bug report describes. The fix MUST NOT make this case
  worse than it is today.
- **Service worker / cached HTML**: If a previously cached HTML response is
  served, the same FOUC-free guarantee applies — cached HTML must not
  reference a stylesheet path that loads after first paint.
- **Reduced motion / prefers-color-scheme**: User preferences applied via
  CSS must be honored on the first paint, not flashed in afterward.
- **Zoom and very narrow viewports**: The fix must not introduce a layout
  shift between the initial styled paint and the post-load layout (no FOUC
  *and* no CLS).
- **Authenticated vs unauthenticated routes**: Both must paint styled on
  first frame.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The app MUST render every top-level route with the app's final
  styling applied on the first painted frame after a page refresh, with no
  observable interval where browser-default styles are visible.
- **FR-002**: The fix MUST cover both warm-cache reloads (Cmd+R) and
  cold-cache hard reloads (Cmd+Shift+R / first-time loads), and MUST hold
  under a slow-network condition representative of a 3G profile.
- **FR-003**: The fix MUST NOT introduce a visible layout shift between the
  initial paint and the fully-loaded state. (No trading FOUC for CLS.)
- **FR-004**: The fix MUST NOT regress time-to-first-contentful-paint of the
  primary feed view by more than a small, agreed margin (see SC-002).
- **FR-005**: The fix MUST work for HTML that is served via the recently
  introduced lazy HTML / initial feed bootstrap path as well as any other
  delivery path (cached HTML, direct route, etc.).
- **FR-006**: The fix MUST work in the browsers and platforms the app
  already supports; it MUST NOT depend on a feature that is unavailable in
  any currently-supported browser.
- **FR-007**: The fix SHOULD include a guard that catches a regression of
  this defect — i.e. some form of automated detection (a check, test, or
  recorded baseline) that fails when a page refresh once again paints
  unstyled content. This is to keep the defect from recurring as the
  rendering pipeline continues to evolve.

### Key Entities

Not applicable — this is a rendering / asset-loading concern, not a data
modeling change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of refreshes on every top-level route paint with app
  styling on the first visible frame, verified by frame-by-frame inspection
  of a screen recording on at least one fast-network and one slow-network
  profile.
- **SC-002**: Time-to-first-contentful-paint on the feed view does not
  regress by more than 10% relative to the pre-fix baseline, measured on the
  same network profile and device.
- **SC-003**: Cumulative Layout Shift (CLS) attributable to the initial
  paint of any top-level route stays at or below the project's existing CLS
  budget; the fix does not push it up.
- **SC-004**: Zero user-visible recurrences of the unstyled-flash symptom
  reported in the bug report after the fix ships, across the supported
  browser/platform matrix.

## Assumptions

- The defect was introduced relatively recently (the user notes "that didn't
  happen in the past"). Recent work on the lazy HTML cache pipeline and the
  initial feed bootstrap (commits on the current branch) is the most likely
  origin of the regression and is in scope to investigate during planning.
- The supported browser matrix is the same as the rest of the app (no
  platform-specific carve-outs for this fix).
- "Page refresh" means any reload of a top-level URL the app exposes,
  including soft reload, hard reload, and opening the URL in a new tab.
- The user-visible symptom in the screenshot — browser-default blue
  underlined links, no app chrome, no app typography — is the exact symptom
  to eliminate. There is no separate "partial styling" state to consider.
- Existing lint, test, and CI workflows remain authoritative; the fix will
  be delivered alongside any tests that protect the FOUC-free guarantee.
