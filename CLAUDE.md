# rsss Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-05-02

## Active Technologies
- Per-user Durable Object SQLite (server-authoritative); local (002-full-article-fetch)
- TypeScript (Cloudflare Workers + ES2022 lib) + Hono (server), Preact + `@preact/signals` (003-defer-new-feed-items)

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
- 003-defer-new-feed-items: Added TypeScript (Cloudflare Workers + ES2022 lib) + Hono (server), Preact + `@preact/signals`
- 002-full-article-fetch: Added TypeScript (Cloudflare Workers runtime, ES2022 lib)


<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
