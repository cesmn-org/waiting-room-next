const jwksCache = new Map();

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function accessCookie(request) {
  const value = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('CF_Authorization='));
  return value ? decodeURIComponent(value.slice('CF_Authorization='.length)) : null;
}
function decodePart(value) { return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))); }
async function getKeys(teamDomain) {
  const cached = jwksCache.get(teamDomain); if (cached) return cached;
  const promise = fetch(`${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`).then(async (response) => { if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`); return response.json(); });
  jwksCache.set(teamDomain, promise); return promise;
}

async function validate(request, env) {
  const assertion = request.headers.get('cf-access-jwt-assertion') || accessCookie(request);
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, '');
  const audience = env.ACCESS_AUDIENCE?.trim();
  const result = { source: request.headers.get('cf-access-jwt-assertion') ? 'header' : request.headers.get('Cookie')?.includes('CF_Authorization=') ? 'cookie' : 'none', teamDomainConfigured: Boolean(teamDomain), audienceConfigured: Boolean(audience), issuerMatches: false, audienceMatches: false, keyFound: false, signatureValid: false, emailPresent: false, failure: '' };
  if (!assertion || !teamDomain || !audience) { result.failure = 'missing-assertion-or-config'; return { result, identity: null }; }
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = assertion.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) { result.failure = 'malformed-jwt'; return { result, identity: null }; }
    const header = decodePart(encodedHeader); const payload = decodePart(encodedPayload);
    result.issuerMatches = payload.iss === teamDomain;
    const now = Math.floor(Date.now() / 1000); const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    result.audienceMatches = audiences.includes(audience);
    if (header.alg !== 'RS256') { result.failure = 'unsupported-algorithm'; return { result, identity: null }; }
    if (!result.issuerMatches) { result.failure = 'issuer-mismatch'; return { result, identity: null }; }
    if (!result.audienceMatches) { result.failure = 'audience-mismatch'; return { result, identity: null }; }
    if (typeof payload.exp !== 'number' || payload.exp <= now || (payload.nbf && payload.nbf > now + 30)) { result.failure = 'expired-or-not-yet-valid'; return { result, identity: null }; }
    const keys = await getKeys(teamDomain); const jwk = keys.keys?.find((key) => key.kid === header.kid); result.keyFound = Boolean(jwk);
    if (!jwk) { result.failure = 'signing-key-not-found'; return { result, identity: null }; }
    const cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    result.signatureValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, base64UrlToBytes(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
    if (!result.signatureValid) { result.failure = 'signature-invalid'; return { result, identity: null }; }
    result.emailPresent = typeof payload.email === 'string';
    if (!result.emailPresent) { result.failure = 'email-missing'; return { result, identity: null }; }
    return { result, identity: { email: payload.email.trim().toLowerCase() } };
  } catch (error) { result.failure = error instanceof Error ? error.message.slice(0, 80) : 'validation-error'; return { result, identity: null }; }
}

export async function accessIdentity(request, env) { return (await validate(request, env)).identity; }
export async function accessDiagnostics(request, env) { return (await validate(request, env)).result; }
export function humanRole(email, env) { const normalized = email.toLowerCase(); if (env.ADMIN_EMAIL?.trim().toLowerCase() === normalized) return 'admin'; if (env.INTAKE_EMAIL?.trim().toLowerCase() === normalized) return 'intake'; return null; }
