const jwksCache = new Map();

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodePart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function getKeys(teamDomain) {
  const cached = jwksCache.get(teamDomain);
  if (cached) return cached;
  const promise = fetch(`${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`).then(async (response) => {
    if (!response.ok) throw new Error('Unable to retrieve Cloudflare Access signing keys');
    return response.json();
  });
  jwksCache.set(teamDomain, promise);
  return promise;
}

export async function accessIdentity(request, env) {
  const assertion = request.headers.get('cf-access-jwt-assertion');
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, '');
  const audience = env.ACCESS_AUDIENCE?.trim();
  if (!assertion || !teamDomain || !audience) return null;

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = assertion.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = decodePart(encodedHeader);
    const payload = decodePart(encodedPayload);
    if (header.alg !== 'RS256' || payload.iss !== teamDomain) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now || (payload.nbf && payload.nbf > now + 30)) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) return null;

    const keys = await getKeys(teamDomain);
    const jwk = keys.keys?.find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, base64UrlToBytes(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
    if (!valid || typeof payload.email !== 'string') return null;
    return { email: payload.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}

export function humanRole(email, env) {
  const normalized = email.toLowerCase();
  if (env.ADMIN_EMAIL?.trim().toLowerCase() === normalized) return 'admin';
  if (env.INTAKE_EMAIL?.trim().toLowerCase() === normalized) return 'intake';
  return null;
}
