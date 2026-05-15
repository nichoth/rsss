import * as Sentry from '@sentry/browser'

const dsn = import.meta.env.VITE_SENTRY_DSN as string|undefined

if (dsn) {
    Sentry.init({
        dsn,
        environment: import.meta.env.MODE,
        release: import.meta.env.VITE_APP_VERSION as string|undefined,

        // The user has opted out of default PII collection.
        sendDefaultPii: false,

        integrations: [
            Sentry.browserTracingIntegration(),
            Sentry.replayIntegration({
                maskAllText: true,
                blockAllMedia: true,
            }),
        ],

        // Tracing: full in dev/staging, sampled in prod
        tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,

        // Send traces only to our own origin so distributed traces
        // reach the Cloudflare Worker.
        tracePropagationTargets: [
            'localhost',
            '127.0.0.1',
            /^\//,
        ],

        // Session Replay: low background rate, full on error
        replaysSessionSampleRate: import.meta.env.PROD ? 0.1 : 0,
        replaysOnErrorSampleRate: 1.0,
    })
}
