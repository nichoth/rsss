interface Env {
    KV: KVNamespace;
}

export const onRequest:PagesFunction<Env> = async (_context) => {
    // const value = await context.env.KV.get('example')
    // return new Response(value)
    return Response.json({ hello: 'world' })
}
