# Feature Specification: Remove Redundant Sync Button from Settings

**Feature Branch**: `013-remove-sync-button`
**Created**: 2026-05-08
**Status**: Draft
**Input**: User description: "The 'Sync' button in the `/settings` route does not
seem to do anything. We should get rid of the 'sync' button, because it is
redundant with the 'refresh feeds' button on the home route. Local cache is
determined by cache settings, not a 'sync' button."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Settings page no longer shows a redundant Sync control (Priority: P1)

A user opens the Settings page to manage their local storage, subscription,
and cache preferences. They are not presented with a "Sync" button (and its
"Pull updates from the server" description) inside the Local Storage section.
The Local Storage section is limited to controls that actually configure
local storage: the toggle for syncing subscriptions/read state to the device,
and the toggle for storing article content locally for offline reading.

**Why this priority**: This is the entire feature. The Sync button has been
reported as visibly non-functional and is conceptually redundant with the
"Refresh feeds" action on the home route. Removing it eliminates user
confusion about what the button does and clarifies the mental model — Local
Storage is a configuration section, not an action surface.

**Independent Test**: Open the application, sign in, navigate to `/settings`,
and verify that the Local Storage section contains only the two configuration
toggles (sync subscriptions/read state, store article content) with no
trailing "Sync" button or "Pull updates from the server" description.

**Acceptance Scenarios**:

1. **Given** a signed-in user with local storage enabled, **When** they
   navigate to `/settings`, **Then** the Local Storage section displays only
   the two configuration toggles and shows no "Sync" button or "Pull updates
   from the server" description.
2. **Given** a signed-in user with local storage disabled, **When** they
   navigate to `/settings`, **Then** no Sync button or related description
   appears (consistent with prior behavior).
3. **Given** a signed-in user is on the home route, **When** they want to
   pull the latest items from the server, **Then** the "Refresh feeds"
   action remains available and continues to work as before.

---

### User Story 2 - No regressions to local-storage configuration controls (Priority: P1)

The two existing Local Storage toggles continue to behave as before:
turning them on or off must still update local-storage configuration and
persist that choice across reloads. Removing the Sync button must not
affect the toggles, the cache settings section, the subscription section,
or the home-route refresh flow.

**Why this priority**: Removing UI must not regress neighboring controls.
The toggles and cache settings are core configuration surfaces that users
rely on; they must remain fully functional.

**Independent Test**: On `/settings`, toggle "Sync subscriptions and read
state to this device" off and on again and verify state is persisted on
reload. Repeat for "Store article content locally for offline reading."
Verify Cache section, Subscription section, and home-route "Refresh feeds"
all still work.

**Acceptance Scenarios**:

1. **Given** the Sync button has been removed, **When** a user toggles
   either Local Storage option, **Then** the toggle persists and any
   resulting side effects (e.g., clearing locally stored article content
   when disabled) still occur.
2. **Given** the Sync button has been removed, **When** a user navigates
   to the home route and triggers "Refresh feeds", **Then** the refresh
   completes successfully and shows updated feed items.
3. **Given** a user has previously interacted with the Sync button (e.g.,
   stale state in memory or storage), **When** they load `/settings` after
   the change, **Then** the page renders without errors and no leftover
   Sync UI or error banner appears in the Local Storage section.

---

### Edge Cases

- A user is in the middle of a sync triggered by an older session/tab when
  the new build loads: the UI must not display Sync controls or sync-error
  banners attached to the Local Storage section. Errors from background
  sync activity must not surface in the Local Storage section UI.
- A user who has no entitlement / is not signed in: behavior must remain
  unchanged for the parts of `/settings` they can see; the removal must
  not introduce new conditional branches that affect this state.
- Browser back/forward navigation between `/settings` and `/`: the home
  route's "Refresh feeds" continues to be the only user-facing way to
  pull updates from the server.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Settings page MUST NOT display a "Sync" button inside
  the Local Storage section.
- **FR-002**: The Settings page MUST NOT display the "Pull updates from
  the server" descriptive text that previously accompanied the Sync
  button.
- **FR-003**: The Settings page MUST NOT display sync-error messages
  inside the Local Storage section. Background sync error surfacing in
  other system-wide indicators (e.g., a global status dot) is out of
  scope for this feature.
- **FR-004**: The two Local Storage toggles ("Sync subscriptions and read
  state to this device" and "Store article content locally for offline
  reading") MUST continue to function exactly as before, including any
  associated confirmations, persistence, and content-purge side effects.
- **FR-005**: The home route's "Refresh feeds" action MUST remain the
  user-facing way to pull updates from the server and MUST continue to
  work as before.
- **FR-006**: The Cache, Subscription, and other Settings sections MUST
  remain visually and functionally unchanged.
- **FR-007**: Removing the Sync button MUST NOT introduce new errors or
  warnings in the browser console under normal use.

### Key Entities

This feature is UI-only and does not introduce, change, or remove any
data entities, schemas, or persisted client/server state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of visits to `/settings` (signed-in, with or without
  local storage enabled) render the Local Storage section without a Sync
  button or "Pull updates from the server" text.
- **SC-002**: 0 user-reported issues mentioning "Sync button does
  nothing" on the Settings page after release.
- **SC-003**: Existing flows that depend on the Local Storage toggles,
  the Cache section, the Subscription section, and the home-route
  "Refresh feeds" action continue to pass with no regressions.
- **SC-004**: A user can identify how to refresh feeds within 10 seconds
  of opening the app, using only the home-route "Refresh feeds" control.

## Assumptions

- The "Refresh feeds" action on the home route is the canonical, user-
  facing way to pull updates from the server, and it is sufficient on its
  own — no new entry point is needed to replace the removed Sync button.
- The Local Storage toggles and the Cache section already provide all the
  user-facing configuration needed for local data; no replacement control
  is required for the removed Sync button.
- Background sync (whatever currently runs automatically without user
  interaction) is unaffected by this change. This feature only removes a
  user-facing button; it does not remove or alter automatic sync behavior.
- The "Sync subscriptions and read state to this device" toggle inside
  Local Storage is a separate, retained control and is NOT in scope for
  removal — only the standalone "Sync" button below the toggles is being
  removed.
- This is a strictly UI-only change; no schema, API, or persisted-state
  migrations are required.
