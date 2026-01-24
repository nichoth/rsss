/**
 * Bluesky AT Protocol OAuth implementation for Cloudflare Workers
 */

export interface OAuthSession {
    did: string
    handle: string
    accessToken: string
    refreshToken: string
    expiresAt: number
}

export interface OAuthState {
    nonce: string
    verifier: string
    returnTo: string
}

// PKCE helpers
function generateRandomString (length: number): string {
    const array = new Uint8Array(length)
    crypto.getRandomValues(array)
    return base64UrlEncode(array)
}

function base64UrlEncode (buffer: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...buffer))
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

async function sha256 (plain: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder()
    const data = encoder.encode(plain)
    return crypto.subtle.digest('SHA-256', data)
}

async function generateCodeChallenge (verifier: string): Promise<string> {
    const hashed = await sha256(verifier)
    return base64UrlEncode(new Uint8Array(hashed))
}

/**
 * Resolve a Bluesky handle to authorization server metadata
 */
async function resolveHandle (handle: string): Promise<{
    did: string
    pds: string
    authServer: string
}> {
    // Normalize handle
    handle = handle.replace('@', '').toLowerCase()

    // Resolve DID via handle resolution
    let did: string

    // Try DNS resolution first
    try {
        const dnsResponse = await fetch(`https://dns.google/resolve?name=_atproto.${handle}&type=TXT`)
        const dnsData = await dnsResponse.json() as { Answer?: Array<{ data: string }> }

        if (dnsData.Answer && dnsData.Answer.length > 0) {
            const record = dnsData.Answer[0].data.replace(/"/g, '')
            if (record.startsWith('did=')) {
                did = record.substring(4)
            } else {
                throw new Error('Invalid TXT record')
            }
        } else {
            throw new Error('No DNS record')
        }
    } catch {
        // Fall back to HTTP well-known
        const wellKnownResponse = await fetch(`https://${handle}/.well-known/atproto-did`)
        if (!wellKnownResponse.ok) {
            throw new Error(`Could not resolve handle: ${handle}`)
        }
        did = (await wellKnownResponse.text()).trim()
    }

    // Get DID document
    let pds: string
    if (did.startsWith('did:plc:')) {
        const plcResponse = await fetch(`https://plc.directory/${did}`)
        if (!plcResponse.ok) {
            throw new Error(`Could not resolve DID: ${did}`)
        }
        const plcData = await plcResponse.json() as { service?: Array<{ id: string; serviceEndpoint: string }> }
        const pdsService = plcData.service?.find(s => s.id === '#atproto_pds')
        if (!pdsService) {
            throw new Error('No PDS service found')
        }
        pds = pdsService.serviceEndpoint
    } else if (did.startsWith('did:web:')) {
        const domain = did.substring(8)
        const didDocResponse = await fetch(`https://${domain}/.well-known/did.json`)
        if (!didDocResponse.ok) {
            throw new Error(`Could not resolve did:web: ${did}`)
        }
        const didDoc = await didDocResponse.json() as { service?: Array<{ id: string; serviceEndpoint: string }> }
        const pdsService = didDoc.service?.find(s => s.id === '#atproto_pds')
        if (!pdsService) {
            throw new Error('No PDS service found')
        }
        pds = pdsService.serviceEndpoint
    } else {
        throw new Error(`Unsupported DID method: ${did}`)
    }

    // Get auth server from PDS
    const pdsMetaResponse = await fetch(`${pds}/.well-known/oauth-protected-resource`)
    if (!pdsMetaResponse.ok) {
        throw new Error('Could not get PDS OAuth metadata')
    }
    const pdsMeta = await pdsMetaResponse.json() as { authorization_servers?: string[] }

    if (!pdsMeta.authorization_servers || pdsMeta.authorization_servers.length === 0) {
        throw new Error('No authorization server found')
    }

    return {
        did,
        pds,
        authServer: pdsMeta.authorization_servers[0]
    }
}

/**
 * Get OAuth server metadata
 */
async function getAuthServerMetadata (authServer: string): Promise<{
    issuer: string
    authorization_endpoint: string
    token_endpoint: string
    pushed_authorization_request_endpoint?: string
}> {
    const response = await fetch(`${authServer}/.well-known/oauth-authorization-server`)
    if (!response.ok) {
        throw new Error('Could not get auth server metadata')
    }
    return response.json()
}

/**
 * Start OAuth flow - returns authorization URL and state to store
 */
export async function startOAuthFlow (
    handle: string,
    clientId: string,
    redirectUri: string,
    returnTo: string = '/'
): Promise<{
    authUrl: string
    state: OAuthState
}> {
    const { did, authServer } = await resolveHandle(handle)
    const metadata = await getAuthServerMetadata(authServer)

    const verifier = generateRandomString(32)
    const codeChallenge = await generateCodeChallenge(verifier)
    const nonce = generateRandomString(16)
    const stateParam = generateRandomString(16)

    const state: OAuthState = {
        nonce,
        verifier,
        returnTo
    }

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: stateParam,
        scope: 'atproto',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: did
    })

    // Use PAR if available
    if (metadata.pushed_authorization_request_endpoint) {
        const parResponse = await fetch(metadata.pushed_authorization_request_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        })

        if (parResponse.ok) {
            const parData = await parResponse.json() as { request_uri: string }
            const authUrl = `${metadata.authorization_endpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(parData.request_uri)}`
            return { authUrl, state }
        }
    }

    // Fall back to regular authorization URL
    const authUrl = `${metadata.authorization_endpoint}?${params.toString()}`
    return { authUrl, state }
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCode (
    code: string,
    state: OAuthState,
    clientId: string,
    redirectUri: string,
    authServer: string
): Promise<OAuthSession> {
    const metadata = await getAuthServerMetadata(authServer)

    const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: state.verifier
        }).toString()
    })

    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Token exchange failed: ${error}`)
    }

    const tokens = await response.json() as {
        access_token: string
        refresh_token?: string
        expires_in?: number
        sub: string
    }

    // Get handle from DID
    let handle = tokens.sub
    try {
        const profileResponse = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${tokens.sub}`)
        if (profileResponse.ok) {
            const profile = await profileResponse.json() as { handle: string }
            handle = profile.handle
        }
    } catch {
        // Use DID as fallback
    }

    return {
        did: tokens.sub,
        handle,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000
    }
}

/**
 * Generate a simple session token
 */
export async function generateSessionToken (): Promise<string> {
    return generateRandomString(32)
}

/**
 * Create a signed session cookie value
 */
export async function createSessionCookie (
    session: OAuthSession,
    secret: string
): Promise<string> {
    const payload = JSON.stringify(session)
    const encoder = new TextEncoder()

    // Create HMAC signature
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )

    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(payload)
    )

    const signatureB64 = base64UrlEncode(new Uint8Array(signature))
    const payloadB64 = btoa(payload)

    return `${payloadB64}.${signatureB64}`
}

/**
 * Verify and decode a session cookie
 */
export async function verifySessionCookie (
    cookie: string,
    secret: string
): Promise<OAuthSession | null> {
    try {
        const [payloadB64, signatureB64] = cookie.split('.')
        if (!payloadB64 || !signatureB64) return null

        const payload = atob(payloadB64)
        const encoder = new TextEncoder()

        // Verify HMAC signature
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        )

        // Decode base64url signature
        const signatureStr = signatureB64
            .replace(/-/g, '+')
            .replace(/_/g, '/')
        const signatureBytes = Uint8Array.from(atob(signatureStr), c => c.charCodeAt(0))

        const valid = await crypto.subtle.verify(
            'HMAC',
            key,
            signatureBytes,
            encoder.encode(payload)
        )

        if (!valid) return null

        return JSON.parse(payload) as OAuthSession
    } catch {
        return null
    }
}
