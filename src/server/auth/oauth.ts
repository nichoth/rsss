/**
 * Bluesky AT Protocol OAuth implementation for Cloudflare Workers
 */

// DPoP key pair stored for the session (in production, persist this securely)
export interface DPoPKeyPair {
    privateKey: CryptoKey
    publicKey: CryptoKey
    publicJwk: JsonWebKey
}

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
    dpopPrivateKeyJwk: JsonWebKey  // DPoP private key for token exchange
    dpopPublicKeyJwk: JsonWebKey   // DPoP public key
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

// ============================================================================
// DPoP (Demonstrating Proof of Possession) Implementation
// ============================================================================

/**
 * Generate an ephemeral ES256 key pair for DPoP
 * Bluesky requires ES256 (P-256 curve) for DPoP proofs
 */
export async function generateDPoPKeyPair (): Promise<DPoPKeyPair> {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: 'ECDSA',
            namedCurve: 'P-256'
        },
        true, // extractable - needed to export public key as JWK
        ['sign', 'verify']
    )

    // Export public key as JWK for the DPoP proof header
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

    return {
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        publicJwk
    }
}

/**
 * Generate a UUID v4 for the DPoP jti claim
 */
function generateJti (): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    // Set version (4) and variant (RFC 4122)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Create a DPoP proof JWT
 *
 * @param keyPair - The DPoP key pair
 * @param httpMethod - The HTTP method (GET, POST, etc.)
 * @param httpUri - The full URL of the request
 * @param accessToken - Optional access token for the 'ath' claim (required when using DPoP with access tokens)
 * @param nonce - Optional server-provided nonce for replay protection
 */
export async function createDPoPProof (
    keyPair: DPoPKeyPair,
    httpMethod: string,
    httpUri: string,
    accessToken?: string,
    nonce?: string
): Promise<string> {
    // DPoP proof header - MUST include the public key
    const header = {
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: {
            kty: keyPair.publicJwk.kty,
            crv: keyPair.publicJwk.crv,
            x: keyPair.publicJwk.x,
            y: keyPair.publicJwk.y
            // Note: Do NOT include 'd' (private key) in the header
        }
    }

    // DPoP proof payload
    const payload: Record<string, string | number> = {
        jti: generateJti(), // Unique identifier to prevent replay
        htm: httpMethod.toUpperCase(), // HTTP method
        htu: httpUri, // HTTP URI (without query and fragment)
        iat: Math.floor(Date.now() / 1000) // Issued at timestamp
    }

    // Add 'ath' claim if access token is provided
    // This binds the DPoP proof to a specific access token
    if (accessToken) {
        const tokenHash = await sha256(accessToken)
        payload.ath = base64UrlEncode(new Uint8Array(tokenHash))
    }

    // Add nonce if provided by the server
    if (nonce) {
        payload.nonce = nonce
    }

    // Encode header and payload
    const encoder = new TextEncoder()
    const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)))
    const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)))

    // Create signature
    const signingInput = `${headerB64}.${payloadB64}`
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        encoder.encode(signingInput)
    )

    // Convert signature from DER to raw format (r || s)
    // WebCrypto ECDSA returns signature in IEEE P1363 format (already r || s)
    const signatureB64 = base64UrlEncode(new Uint8Array(signature))

    return `${headerB64}.${payloadB64}.${signatureB64}`
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
 *
 * Generates a DPoP key pair that must be stored and reused for token exchange.
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

    // Generate DPoP key pair for this OAuth session
    const dpopKeyPair = await generateDPoPKeyPair()

    // Export private key to JWK for storage in state
    const dpopPrivateKeyJwk = await crypto.subtle.exportKey('jwk', dpopKeyPair.privateKey)

    const state: OAuthState = {
        nonce,
        verifier,
        returnTo,
        dpopPrivateKeyJwk,
        dpopPublicKeyJwk: dpopKeyPair.publicJwk
    }

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: nonce,
        scope: 'atproto',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: did
    })

    // Use PAR if available (required by Bluesky)
    if (metadata.pushed_authorization_request_endpoint) {
        // Create DPoP proof for the PAR endpoint
        const parDpopProof = await createDPoPProof(
            dpopKeyPair,
            'POST',
            metadata.pushed_authorization_request_endpoint
        )

        let parResponse = await fetch(metadata.pushed_authorization_request_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'DPoP': parDpopProof
            },
            body: params.toString()
        })

        // Handle DPoP nonce requirement
        if (parResponse.status === 400 || parResponse.status === 401) {
            const dpopNonce = parResponse.headers.get('DPoP-Nonce')
            if (dpopNonce) {
                const parDpopProofWithNonce = await createDPoPProof(
                    dpopKeyPair,
                    'POST',
                    metadata.pushed_authorization_request_endpoint,
                    undefined,
                    dpopNonce
                )

                parResponse = await fetch(metadata.pushed_authorization_request_endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'DPoP': parDpopProofWithNonce
                    },
                    body: params.toString()
                })
            }
        }

        if (parResponse.ok) {
            const parData = await parResponse.json() as { request_uri: string }
            const authUrl = `${metadata.authorization_endpoint}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(parData.request_uri)}`
            return { authUrl, state }
        }

        // Log PAR failure for debugging
        const parError = await parResponse.text()
        console.error('PAR request failed:', parError)
    }

    // Fall back to regular authorization URL (may not work with Bluesky)
    const authUrl = `${metadata.authorization_endpoint}?${params.toString()}`
    return { authUrl, state }
}

/**
 * Restore a DPoP key pair from exported JWKs
 */
async function restoreDPoPKeyPair (
    privateKeyJwk: JsonWebKey,
    publicKeyJwk: JsonWebKey
): Promise<DPoPKeyPair> {
    const privateKey = await crypto.subtle.importKey(
        'jwk',
        privateKeyJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign']
    )

    const publicKey = await crypto.subtle.importKey(
        'jwk',
        publicKeyJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
    )

    return {
        privateKey,
        publicKey,
        publicJwk: publicKeyJwk
    }
}

/**
 * Exchange authorization code for tokens
 *
 * Bluesky requires DPoP (Demonstrating Proof of Possession) for token requests.
 * Uses the same DPoP key pair that was used during the PAR request.
 *
 * @param code - Authorization code from the callback
 * @param state - OAuth state containing the PKCE verifier and DPoP keys
 * @param clientId - OAuth client ID
 * @param redirectUri - Redirect URI used in the authorization request
 * @param authServer - Authorization server URL
 */
export async function exchangeCode (
    code: string,
    state: OAuthState,
    clientId: string,
    redirectUri: string,
    authServer: string
): Promise<OAuthSession & { dpopKeyPair: DPoPKeyPair }> {
    const metadata = await getAuthServerMetadata(authServer)

    // Restore the DPoP key pair from the stored JWKs
    const keyPair = await restoreDPoPKeyPair(
        state.dpopPrivateKeyJwk,
        state.dpopPublicKeyJwk
    )

    // Create DPoP proof for the token endpoint
    const dpopProof = await createDPoPProof(
        keyPair,
        'POST',
        metadata.token_endpoint
    )

    // Make initial token request with DPoP proof
    let response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'DPoP': dpopProof
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: state.verifier
        }).toString()
    })

    // Handle DPoP nonce requirement (server may require a nonce for replay protection)
    if (response.status === 400 || response.status === 401) {
        const dpopNonce = response.headers.get('DPoP-Nonce')
        if (dpopNonce) {
            // Retry with the server-provided nonce
            const dpopProofWithNonce = await createDPoPProof(
                keyPair,
                'POST',
                metadata.token_endpoint,
                undefined,
                dpopNonce
            )

            response = await fetch(metadata.token_endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'DPoP': dpopProofWithNonce
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                    client_id: clientId,
                    code_verifier: state.verifier
                }).toString()
            })
        }
    }

    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Token exchange failed: ${error}`)
    }

    const tokens = await response.json() as {
        access_token: string
        refresh_token?: string
        expires_in?: number
        sub: string
        token_type?: string
    }

    // Verify we got a DPoP-bound token
    if (tokens.token_type?.toLowerCase() !== 'dpop') {
        console.warn('Warning: Expected DPoP token type but got:', tokens.token_type)
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
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
        dpopKeyPair: keyPair // Return key pair for subsequent API calls
    }
}

/**
 * Make an authenticated API request with DPoP
 *
 * When using DPoP-bound access tokens, each request must include a fresh DPoP proof
 * with the 'ath' claim containing a hash of the access token.
 *
 * @param url - The API endpoint URL
 * @param method - HTTP method
 * @param accessToken - The DPoP-bound access token
 * @param keyPair - The DPoP key pair used during token exchange
 * @param options - Additional fetch options (body, additional headers, etc.)
 */
export async function fetchWithDPoP (
    url: string,
    method: string,
    accessToken: string,
    keyPair: DPoPKeyPair,
    options: RequestInit = {}
): Promise<Response> {
    // Create DPoP proof with 'ath' claim for the access token
    const dpopProof = await createDPoPProof(
        keyPair,
        method,
        url,
        accessToken // Include access token hash in the proof
    )

    const headers = new Headers(options.headers)
    headers.set('Authorization', `DPoP ${accessToken}`)
    headers.set('DPoP', dpopProof)

    let response = await fetch(url, {
        ...options,
        method,
        headers
    })

    // Handle DPoP nonce requirement
    if (response.status === 401) {
        const dpopNonce = response.headers.get('DPoP-Nonce')
        if (dpopNonce) {
            const dpopProofWithNonce = await createDPoPProof(
                keyPair,
                method,
                url,
                accessToken,
                dpopNonce
            )

            const retryHeaders = new Headers(options.headers)
            retryHeaders.set('Authorization', `DPoP ${accessToken}`)
            retryHeaders.set('DPoP', dpopProofWithNonce)

            response = await fetch(url, {
                ...options,
                method,
                headers: retryHeaders
            })
        }
    }

    return response
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
