import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
    ASSETS:Fetcher
}

const app = new Hono<{ Bindings:Bindings }>()

app.use('/api/*', cors())

/**
 * Health check
 */
app.get('/api/health', (c) => {
    return c.json({ status: 'ok', service: 'example' })
})

app.get('/api/helloworld', (c) => {
    return c.json({ message: 'Hello, World!' })
})

app.get('/health', c => {
    return c.json({ status: 'ok' })
})

/**
 * Serve static assets (Preact frontend)
 */
app.all('*', (c) => {
    if (!(c.env?.ASSETS)) {
        // In dev mode, let Vite handle static assets
        return c.notFound()
    }

    return c.env.ASSETS.fetch(c.req.raw)
})

export default app
