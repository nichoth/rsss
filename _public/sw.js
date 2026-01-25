'use strict';
(() => {
    // src/sw/sw.ts
    const CACHE_NAME = 'rsss-v1'
    const STATIC_ASSETS = [
        '/',
        '/index.html',
        '/manifest.json'
    ]
    self.addEventListener('install', (event) => {
        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.addAll(STATIC_ASSETS)
            })
        )
        self.skipWaiting()
    })
    self.addEventListener('activate', (event) => {
        event.waitUntil(
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
                )
            })
        )
        self.clients.claim()
    })
    self.addEventListener('fetch', (event) => {
        const { request } = event
        const url = new URL(request.url)
        if (request.method !== 'GET') {
            return
        }
        if (url.pathname.startsWith('/api/')) {
            return
        }
        if (request.mode === 'navigate') {
            event.respondWith(
                fetch(request).then((response) => {
                    if (response.ok) {
                        const responseClone = response.clone()
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(request, responseClone)
                        })
                    }
                    return response
                }).catch(async () => {
                    const cached = await caches.match(request)
                    if (cached) return cached
                    const fallback = await caches.match('/')
                    return fallback || new Response('Offline', { status: 503 })
                })
            )
            return
        }
        if (url.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|eot)$/)) {
            event.respondWith(
                caches.match(request).then((cached) => {
                    if (cached) {
                        fetch(request).then((response) => {
                            if (response.ok) {
                                caches.open(CACHE_NAME).then((cache) => {
                                    cache.put(request, response)
                                })
                            }
                        }).catch(() => {
                        })
                        return cached
                    }
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
        event.respondWith(
            fetch(request).then((response) => {
                if (response.ok) {
                    const responseClone = response.clone()
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone)
                    })
                }
                return response
            }).catch(async () => {
                const cached = await caches.match(request)
                return cached || new Response('Offline', { status: 503 })
            })
        )
    })
})()
