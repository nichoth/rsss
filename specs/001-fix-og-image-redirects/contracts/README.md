# Contracts

This feature does not change any external interface.

- The `/api/refresh` endpoint contract (request shape, response shape,
  status semantics) is unchanged.
- The `/api/sync` payload is unchanged (no schema columns added or
  removed; see [../data-model.md](../data-model.md)).
- The Durable Object's `fetch` handler routing is unchanged.
- No new client SDK, CLI command, or public function is introduced.
- The `FeedFetchError` class continues to expose `{ message, status }`
  exactly as it does today; only the *value* of `message` differs on
  the article-fetch redirect-cap branch (`'Article redirected too many
  times'` instead of `'Feed redirected too many times'`).

If a future change adds a debug surface for OG-enrichment diagnostics
(see Phase 0 R-4), that change will introduce its own contract document
here.
