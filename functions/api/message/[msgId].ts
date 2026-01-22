import type { Env } from '../../../_functions/types'

/**
 * This file will match requests like `/api/message/123`.
 */
export const onRequest:PagesFunction<Env> = async (ctx) => {
    if (ctx.request.method !== 'GET') {
        return new Response(null, { status: 405 })
    }

    const { env } = ctx
    // a URL like /api/message/<id>
    const { msgId } = ctx.params

    if (!env.SECRET) {
        return new Response('Missing env variable', { status: 500 })
    }

    return new Response(`Hello, message ID ${msgId}`, { status: 200 })
}
