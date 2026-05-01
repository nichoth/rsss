# PRD: Granular Cache Controls

## 1. Introduction / Overview

rsss caches feeds locally so users can read them offline. Today, caching
is a single all-or-nothing toggle (`storeContent`) that stores text for
every subscribed feed. There is no control over images, no size budget,
no expiration, and no per-feed override.

This feature adds **granular cache controls** so users can choose, both
site-wide and per-feed:

- whether to cache **text only** or **text + images**
- a **maximum cache size** (per-feed and account-wide)
- a **maximum age (TTL)** for cached items before eviction

It also surfaces **storage usage per feed** with a "Clear cache" button
so users can see and reclaim space.

The controls live on `/settings` (site-wide defaults + a mirrored
per-feed list) and on each individual feed page.

## 2. Goals

- Let users opt in/out of image caching per feed and site-wide.
- Let users cap cache size per feed and per account.
- Let users set a maximum age for cached items.
- Make per-feed settings override site-wide defaults; site-wide defaults
  apply only to feeds with no explicit setting.
- Show storage used per feed and let users clear a feed's cache.
- Apply downgrade actions (e.g. "text+images" -> "text only") on the
  next sync rather than immediately, so the UI stays responsive.

## 3. User Stories

### US-001: Add cache-policy schema to local DB

**Description:** As a developer, I need to persist per-feed cache policy
and site-wide defaults so settings survive reload and sync correctly.

**Acceptance Criteria:**
- [ ] Add `feed_cache_policy` table keyed by feed id with columns:
      `cache_mode` ('text' | 'text_images' | NULL),
      `max_size_bytes` (INTEGER NULL),
      `max_age_seconds` (INTEGER NULL),
      `updated_at` (TEXT)
- [ ] NULL on any column means "inherit site-wide default"
- [ ] Add site-wide defaults to `local-first-settings.ts`:
      `defaultCacheMode`, `defaultMaxSizeBytes`, `defaultMaxAgeSeconds`
- [ ] Defaults persist via existing localStorage key
- [ ] Migration is idempotent (uses `IF NOT EXISTS`)
- [ ] Typecheck and lint pass

### US-002: Track cached image storage on disk

**Description:** As a developer, I need to record which images have been
cached locally and how many bytes each takes, so size limits and the
storage display work.

**Acceptance Criteria:**
- [ ] Add `cached_images` table:
      `url` (TEXT PK), `feed_id` (INTEGER), `item_id` (INTEGER),
      `bytes` (INTEGER), `cached_at` (TEXT)
- [ ] Service worker / image fetch path writes a row per cached image
- [ ] Removing a row also evicts the image from the SW Cache Storage
- [ ] Typecheck and lint pass

### US-003: Site-wide default cache controls on /settings

**Description:** As a user, I want to set defaults for image caching,
max size, and max age on `/settings` so all feeds without explicit
overrides follow the same policy.

**Acceptance Criteria:**
- [ ] New "Cache" section on `/settings` with:
      - radio: "Text only" / "Text + images"
      - input: max cache size per feed (MB)
      - input: max age (days)
- [ ] Changes save immediately and survive reload
- [ ] Inputs validate (positive integers, reasonable max)
- [ ] Section explains "These defaults apply to feeds with no override"
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-004: Per-feed cache controls on /settings feed list

**Description:** As a user, I want to see and edit cache settings for
each feed from the `/settings` feed list so I can manage everything in
one place.

**Acceptance Criteria:**
- [ ] Each feed row in the settings list shows current effective cache
      mode (with "(default)" tag if inherited)
- [ ] Expand/edit affordance reveals per-feed controls:
      - cache mode: "Use default" / "Text only" / "Text + images"
      - max size override (blank = use default)
      - max age override (blank = use default)
- [ ] Saving "Use default" clears the override (writes NULL)
- [ ] Effective values displayed update after save
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-005: Per-feed cache controls on the feed page

**Description:** As a user, I want to change a single feed's cache
settings while reading it, without navigating to `/settings`.

**Acceptance Criteria:**
- [ ] Feed-reader page exposes a cache-controls UI (e.g. menu/drawer)
      mirroring the per-feed controls from US-004
- [ ] Edits write to the same store as US-004 and stay in sync
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-006: Show storage used per feed

**Description:** As a user, I want to see how much space each feed's
cache is using so I can make informed cleanup decisions.

**Acceptance Criteria:**
- [ ] Each feed in the `/settings` list shows storage used
      (text bytes + image bytes, formatted human-readable)
- [ ] Total for the account shown at top of the cache section
- [ ] Numbers update after a clear or after sync
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-007: Clear cache per feed

**Description:** As a user, I want a "Clear cache" button per feed so I
can free space for one feed without nuking everything.

**Acceptance Criteria:**
- [ ] "Clear cache" button on each feed row (and on the feed page)
- [ ] Confirmation prompt before clearing
- [ ] Action removes cached text and cached images for that feed only
- [ ] Storage display updates after clear
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

### US-008: Apply policy changes on next sync

**Description:** As a developer, I need cache policy changes to be
applied during the next sync/cache refresh so users don't see a
freeze when toggling settings.

**Acceptance Criteria:**
- [ ] Toggling a feed from "text+images" to "text only" does NOT delete
      images synchronously
- [ ] On next pull-sync (or scheduled cleanup pass), images for that
      feed are evicted
- [ ] Items older than `max_age_seconds` are evicted on next sync
- [ ] If feed cache exceeds `max_size_bytes`, oldest items are evicted
      first until under the limit
- [ ] Eviction never deletes items still being read in an open tab
      (best-effort: skip the currently-open item)
- [ ] Typecheck and lint pass

### US-009: Enforce account-wide size cap

**Description:** As a user, I want to cap total cache size across all
feeds so the app cannot grow unbounded on disk.

**Acceptance Criteria:**
- [ ] Site-wide max-size input on `/settings` (separate from per-feed)
- [ ] On next sync, if total cache exceeds the cap, evict oldest items
      across all feeds first
- [ ] Per-feed caps are still respected
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill

## 4. Functional Requirements

- FR-1: Persist per-feed cache policy in a new `feed_cache_policy`
  table; NULL columns mean "inherit site default".
- FR-2: Persist site-wide defaults (`defaultCacheMode`,
  `defaultMaxSizeBytes`, `defaultMaxAgeSeconds`) via the existing
  local-first settings localStorage key.
- FR-3: Effective policy resolution: per-feed value if non-NULL, else
  site-wide default, else hard-coded fallback.
- FR-4: `/settings` must include a Cache section with site-wide default
  controls (mode, max size, max age).
- FR-5: `/settings` feed list must show effective cache mode and
  storage used per feed, and let users edit overrides inline.
- FR-6: Each feed page must mirror the per-feed cache controls so they
  can be edited in context.
- FR-7: Image caching must record `(url, feed_id, item_id, bytes,
  cached_at)` so it can be queried and evicted.
- FR-8: Eviction passes run on each sync cycle and apply, in order:
  (a) age > max_age, (b) per-feed size > cap, (c) account total > cap.
- FR-9: "Clear cache" must remove text + image rows + SW cache entries
  for the specified feed only.
- FR-10: Saving a per-feed override of "Use default" must write NULL to
  the corresponding column (not the current default's value).
- FR-11: All cache-policy edits sync via the existing outbox if/when
  sync is enabled; locally-only otherwise.

## 5. Non-Goals (Out of Scope)

- No per-item cache controls (only per-feed and site-wide).
- No automatic predictions or "smart" caching ("only cache feeds you
  read most" etc.) -- explicit user controls only.
- No background eviction outside of sync cycles (no separate timer).
- No video/audio caching policy in this iteration.
- No export/import of cache settings.
- No notifications when cache fills up (only the storage display).
- No retroactive deletion of images when downgrading a feed -- always
  deferred to next sync (per answer 2D).

## 6. Design Considerations

- Reuse existing settings layout in `src/client/routes/settings.ts` and
  the `local-first-section` pattern.
- Reuse the existing per-feed list rendering at `settings-feeds-list`.
- Match the existing `@preact/signals` + `batch` style used in
  `local-first-settings.ts`.
- Storage numbers should be formatted with a small helper
  (`formatBytes`) -- see if one already exists in `src/client/util.ts`
  before adding.
- Per-feed editor should collapse by default to keep the feed list
  scannable.

## 7. Technical Considerations

- Image caching presumably lives in the service worker
  (`src/sw/`) -- the new `cached_images` table needs to be reachable
  from there or from the SQLite worker (`src/client/db/sqlite-worker*`).
  Confirm the data path during US-002.
- `purgeStoredContent` in `src/client/db/content-storage.ts` already
  clears all text content; the per-feed clear in US-007 should be
  modeled similarly but scoped by `feed_id`.
- Eviction order matters: TTL first (cheap, predictable), then size
  caps. Always pick oldest-by-`cached_at` to evict.
- All policy changes must go through `batch()` when toggling multiple
  signals, per project convention.
- Write CSS using nested selectors per CLAUDE.md style.

## 8. Success Metrics

- Users can disable image caching for a feed in <= 2 clicks from the
  feed page or `/settings`.
- After a "Clear cache" action, the storage display drops to 0 for that
  feed and the freed bytes are reflected in the account total.
- Total cache size never exceeds the configured account cap by more
  than one sync cycle's worth of fetches.
- No regressions in existing sync or `storeContent` behavior.

## 9. Open Questions

- Should the existing `storeContent` toggle map onto the new
  site-wide default (e.g. `false` -> "no cache at all")? Or should it
  remain a separate master switch above the new controls?
- Does the SW already record per-image bytes anywhere we can
  piggyback on, or do we need to wrap the fetch path?
- Should the per-feed editor on the feed page be a dropdown menu, an
  inline panel, or a modal? (Defer to design pass during US-005.)
- What's a sensible default for site-wide max age and max size on
  fresh installs? (Suggest: 30 days, 50 MB per feed, 500 MB account.)
