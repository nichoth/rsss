# rsss Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-05-04

## Active Technologies
- Per-user Durable Object SQLite (server-authoritative); local (002-full-article-fetch)
- TypeScript (Cloudflare Workers + ES2022 lib) + Hono (server), Preact + `@preact/signals` (003-defer-new-feed-items)
- TypeScript (browser, ES2022 lib via Vite) + Preact, `@preact/signals`, `htm/preact` (006-sync-status-legend)
- N/A (pure UI; consumes existing client signals) (006-sync-status-legend)
- TypeScript (browser, ES2022 lib via Vite) + Preact, `@preact/signals`, `htm/preact`, (007-cache-settings-disclosure)
- N/A (UI-only; reuses existing per-feed cache policy (007-cache-settings-disclosure)

- TypeScript (Cloudflare Workers runtime, ES2022 lib) + `hono`, `@cloudflare/workers-types`, `fast-xml-parser` (001-fix-og-image-redirects)

## Project Structure

```text
backend/
frontend/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript (Cloudflare Workers runtime, ES2022 lib): Follow standard conventions

## Recent Changes
- 007-cache-settings-disclosure: Added TypeScript (browser, ES2022 lib via Vite) + Preact, `@preact/signals`, `htm/preact`,
- 006-sync-status-legend: Added TypeScript (browser, ES2022 lib via Vite) + Preact, `@preact/signals`, `htm/preact`
- 005-feed-unread-counts: Extended `CountsResponse` with `perFeed:Record<string,number>` (no schema change) so the sidebar can render a per-feed unread count alongside "All Feeds"


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
