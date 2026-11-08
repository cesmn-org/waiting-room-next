import { WaitingRoom } from './room.js';

export { WaitingRoom };

const queueId = 'main-queue';

function staffEmail(request) {
  return request.headers.get('cf-access-authenticated-user-email')?.trim() || null;
}

function unauthorized() {
  return Response.json({ error: 'Staff authentication required' }, { status: 401 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const email = staffEmail(request);
    const isQueueApi = url.pathname === '/api/queue' || url.pathname.startsWith('/api/queue/');
    const isMutation = ['POST', 'PATCH', 'DELETE'].includes(request.method);

    if (url.pathname === '/api/session' && request.method === 'GET') {
      if (!email) return unauthorized();
      return Response.json({ email });
    }

    if (isQueueApi && isMutation && !email) return unauthorized();

    if (isQueueApi || url.pathname === '/ws') {
      const id = env.QUEUE.idFromName(queueId);
      return env.QUEUE.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
