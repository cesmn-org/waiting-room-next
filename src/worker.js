import { WaitingRoom } from './room.js';

export { WaitingRoom };

const queueId = 'main-queue';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/queue' || url.pathname.startsWith('/api/queue/') || url.pathname === '/ws') {
      const id = env.QUEUE.idFromName(queueId);
      return env.QUEUE.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
