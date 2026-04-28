const COOP = 'Cross-Origin-Opener-Policy'
const COEP = 'Cross-Origin-Embedder-Policy'

export function withIsolationHeaders (response:Response):Response {
    const ct = response.headers.get('content-type') ?? ''
    if (
        !ct.includes('text/html') &&
        !ct.includes('javascript') &&
        ct !== ''
    ) {
        return response
    }

    const next = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    })

    next.headers.set(COOP, 'same-origin')
    // `credentialless` keeps cross-origin isolation while allowing embeds.
    // Browser cross-origin image subresource requests omit auth cookies.
    next.headers.set(COEP, 'credentialless')

    return next
}
