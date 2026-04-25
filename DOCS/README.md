# docs

## PWA

### PWA Manifest (`_public/manifest.json`)

* App name, icons, theme color
* Standalone display mode for installability

### Service Worker (_public/sw.js)

* Caches static assets for offline use
* Network-first strategy for pages
* Cache-first for static assets (JS, CSS, images)
* Skips caching API requests

### Updated HTML (index.html)

* PWA meta tags (theme-color, apple-mobile-web-app-*)
* Manifest link
* Service worker registration script

### How It Works

1. Online: Uses remote API adapter (existing behavior)
2. Offline sync: Click "Pull from Server" in sidebar to sync data to local SQLite
3. Installable: Users can install as PWA from browser menu
4. Offline capable: Service worker caches the app shell

>
> !NOTE
> The use of SQLite in the browser.
>

SQLite needs to work in a browser/PWA environment. Should use Web Assembly.

### Test

```sh
npm run build
npm start
```
