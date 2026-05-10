# Phase 1 Data Model: Fix Dev Server FOUC and Vite Dynamic-Import Warning

## Entities

None. This feature is a dev-pipeline / worker-routing concern. It
adds no new data, mutates no existing data, and changes no schema:

- No SQLite schema change (DO storage or client OPFS).
- No `/api/sync` payload change.
- No `HTML_KV` key-shape change. The cache-key prefix `html:v2:`
  introduced by feature 015 is unchanged. The dev branch simply does
  not consult the cache; production reads/writes proceed as today.
- No new `c.env` binding.
- No new client signal, no new component, no new route.

## Validation rules

Not applicable.

## State transitions

Not applicable.
