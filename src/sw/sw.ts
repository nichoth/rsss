// TypeScript needs this to recognize service worker globals
declare const self:ServiceWorkerGlobalScope

export type {}  // Make this a module

/**
 * RSSS Service Worker
 *   - offline support
 */

const CACHE_NAME = 'rsss-v1'

// Assets to cache on install
const STATIC_ASSETS:string[] = [
    '/',
    '/index.html',
    '/manifest.json'
]

// Install event - cache static assets
self.addEventListener('install', (ev:ExtendableEvent) => {
    ev.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS)
        })
    )

    // Activate immediately
    self.skipWaiting()
})

// Activate event - clean up old caches
self.addEventListener('activate', (event:ExtendableEvent) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            )
        })
    )
    // Take control of all clients immediately
    self.clients.claim()
})

/**
 * Fetch event -- network first, fallback to cache
 */
self.addEventListener('fetch', (event:FetchEvent) => {
    const { request } = event
    const url = new URL(request.url)

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return
    }

    // Skip API requests - always go to network
    if (url.pathname.startsWith('/api/')) {
        return
    }

    // For navigation requests (HTML pages), use network-first
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    // Cache successful responses
                    if (response.ok) {
                        const responseClone = response.clone()
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(request, responseClone)
                        })
                    }
                    return response
                })
                .catch(async () => {
                    // Fallback to cache when offline
                    const cached = await caches.match(request)
                    if (cached) return cached
                    const fallback = await caches.match('/')
                    return fallback || new Response('Offline', { status: 503 })
                })
        )
        return
    }

    // For static assets, use cache-first
    if (
        url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|eot)$/)
    ) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) {
                    // Return cached, but also update cache in background
                    fetch(request).then((response) => {
                        if (response.ok) {
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(request, response)
                            })
                        }
                    }).catch(() => {
                        // Ignore fetch errors for background update
                    })
                    return cached
                }

                // Not in cache, fetch and cache
                return fetch(request).then((response) => {
                    if (response.ok) {
                        const responseClone = response.clone()
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(request, responseClone)
                        })
                    }
                    return response
                })
            })
        )
        return
    }

    // Default -- network first, cache fallback
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    const responseClone = response.clone()
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone)
                    })
                }
                return response
            })
            .catch(async () => {
                const cached = await caches.match(request)
                return cached || new Response('Offline', { status: 503 })
            })
    )
})
