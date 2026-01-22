/**
 * Handle headers.
 */
export async function onRequest (ctx) {
    if (ctx.request.method === 'OPTIONS') {
        if (ctx.env.NODE_ENV === 'development') {
            const res = new Response(null, {
                headers: {
                    'access-control-allow-methods': 'PUT,OPTIONS',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers':
                        'Origin, X-Requested-With, Content-Type, Accept, Authorization',
                    'Access-Control-Max-Age': '2592000',
                    'Access-Control-Allow-Credentials': 'true',
                }
            })

            return res
        }

        const res = new Response(null, {
            headers: {
                'access-control-allow-methods': 'PUT,OPTIONS',
                'Access-Control-Allow-Origin': 'https://vanishing.page',
                'Access-Control-Allow-Headers':
                    'Origin, X-Requested-With, Content-Type, Accept, Authorization',
                'Access-Control-Max-Age': '2592000',
                'Access-Control-Allow-Credentials': 'true',
            }
        })

        return res
    }

    return await ctx.next()
}
