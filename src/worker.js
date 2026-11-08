import { WaitingRoom } from './room.js';
import { accessIdentity, humanRole } from './access.js';

export { WaitingRoom };
const queueId = 'main-queue';
const DEVICE_COOKIE = 'waiting_room_device';

function unauthorized(message = 'Authentication required', request, env) {
  const response = Response.json({ error: message }, { status: 401 });
  if (request && env) {
    response.headers.set('X-Waiting-Room-Auth-Debug', JSON.stringify({
      accessJwtHeader: Boolean(request.headers.get('cf-access-jwt-assertion')),
      accessCookie: Boolean(request.headers.get('Cookie')?.includes('CF_Authorization=')),
      teamDomainConfigured: Boolean(env.ACCESS_TEAM_DOMAIN),
      audienceConfigured: Boolean(env.ACCESS_AUDIENCE),
      adminEmailConfigured: Boolean(env.ADMIN_EMAIL),
      intakeEmailConfigured: Boolean(env.INTAKE_EMAIL),
    }));
  }
  return response;
}
function forbidden() { return Response.json({ error: 'Insufficient permissions' }, { status: 403 }); }
function cookie(request) { return request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${DEVICE_COOKIE}=`))?.slice(DEVICE_COOKIE.length + 1) || null; }
function queueStub(env) { return env.QUEUE.get(env.QUEUE.idFromName(queueId)); }

async function devicePermission(request, env) {
  const value = cookie(request);
  if (!value) return null;
  const response = await queueStub(env).fetch(new Request('https://queue.internal/api/device/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: value }) }));
  if (!response.ok) return null;
  return (await response.json()).permission || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const identity = await accessIdentity(request, env);
    const role = identity ? humanRole(identity.email, env) : null;
    const isHumanRoute = url.pathname === '/api/session' || url.pathname.startsWith('/api/pair/approve') || url.pathname.startsWith('/api/pair/deny');

    if (url.pathname === '/api/session' && request.method === 'GET') {
      if (identity && role) return Response.json({ email: identity.email, role });
      const permission = await devicePermission(request, env);
      if (permission) return Response.json({ email: null, role: permission });
      return unauthorized('Valid Cloudflare Access authentication or device pairing required', request, env);
    }

    if (url.pathname === '/api/devices' || url.pathname === '/api/devices/revoke') {
      if (!identity || !role) return unauthorized('Valid Cloudflare Access authentication required', request, env);
      if (!['admin', 'intake'].includes(role)) return forbidden();
      return queueStub(env).fetch(request);
    }

    if (url.pathname === '/api/pair/pending') {
      if (!identity || !role) return unauthorized('Valid Cloudflare Access authentication required', request, env);
      if (!['admin', 'intake'].includes(role)) return forbidden();
      return queueStub(env).fetch(request);
    }

    if (url.pathname === '/api/pair/approve' || url.pathname === '/api/pair/deny') {
      if (!identity || !role) return unauthorized('Valid Cloudflare Access authentication required', request, env);
      if (!['admin', 'intake'].includes(role)) return forbidden();
      const stub = queueStub(env);
      const headers = new Headers(request.headers);
      headers.set('X-Approved-By-Role', role);
      return stub.fetch(new Request(request, { headers }));
    }

    if (url.pathname === '/api/pair' || url.pathname === '/api/pair/status' || url.pathname === '/api/pair/complete') {
      const response = await queueStub(env).fetch(request);
      if (url.pathname === '/api/pair/complete' && response.ok) {
        const data = await response.clone().json();
        if (data.credential) {
          const result = Response.json({ ok: true, permission: data.permission });
          result.headers.append('Set-Cookie', `${DEVICE_COOKIE}=${data.credential}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`);
          return result;
        }
      }
      return response;
    }

    const isQueueApi = url.pathname === '/api/queue' || url.pathname.startsWith('/api/queue/');
    const isWebSocket = url.pathname === '/ws';
    if (isQueueApi || isWebSocket) {
      const isMutation = ['POST', 'PATCH', 'DELETE'].includes(request.method);
      if (identity && role) {
        if (isMutation && !['admin', 'intake'].includes(role)) return forbidden();
      } else {
        const permission = await devicePermission(request, env);
        if (!permission) return unauthorized('Device pairing required');
        if (isMutation && permission !== 'tablet') return forbidden();
      }
      return queueStub(env).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
