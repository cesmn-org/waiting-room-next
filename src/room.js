const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS queue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    appointment_time TEXT,
    check_in_time TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('checked_in', 'shopping')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mutations (
    mutation_id TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export class WaitingRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(CREATE_TABLE);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/queue' && request.method === 'GET') return Response.json(this.listEntries());
    if (url.pathname.startsWith('/api/queue') && request.method !== 'GET') return this.mutate(request, url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: 'queue.snapshot', entries: this.listEntries() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found', { status: 404 });
  }

  async mutate(request, url) {
    const mutationId = request.headers.get('X-Mutation-Id');
    if (!mutationId) return Response.json({ error: 'Mutation ID is required' }, { status: 400 });
    const prior = this.sql.exec('SELECT response FROM mutations WHERE mutation_id = ?', mutationId).toArray()[0];
    if (prior) return Response.json(JSON.parse(prior.response));

    const body = request.method === 'DELETE' ? {} : await request.json().catch(() => null);
    if (!body) return Response.json({ error: 'A valid JSON body is required' }, { status: 400 });

    const path = url.pathname.replace(/\/$/, '');
    let result;
    const now = new Date().toISOString();
    const entryId = Number(path.split('/').pop());
    if (request.method === 'DELETE' && path === '/api/queue') {
      this.sql.exec('DELETE FROM queue_entries');
      result = { cleared: true };
    } else if (request.method === 'POST' && url.pathname === '/api/queue') {
      if (!body.firstName || !body.lastName || !body.checkInTime) return Response.json({ error: 'Names and check-in time are required' }, { status: 400 });
      this.sql.exec('INSERT INTO queue_entries (first_name,last_name,appointment_time,check_in_time,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', body.firstName.trim(), body.lastName.trim(), body.appointmentTime || null, body.checkInTime, 'checked_in', now, now);
      result = this.sql.exec('SELECT id FROM queue_entries ORDER BY id DESC LIMIT 1').toArray()[0];
    } else if (request.method === 'PATCH' && Number.isInteger(entryId)) {
      const current = this.sql.exec('SELECT * FROM queue_entries WHERE id=?', entryId).toArray()[0];
      if (!current) return Response.json({ error: 'Client not found' }, { status: 404 });
      const status = body.status ?? current.status;
      if (!['checked_in', 'shopping'].includes(status)) return Response.json({ error: 'Invalid status' }, { status: 400 });
      const firstName = body.firstName ?? current.first_name;
      const lastName = body.lastName ?? current.last_name;
      const appointmentTime = body.appointmentTime === undefined ? current.appointment_time : body.appointmentTime || null;
      const checkInTime = body.checkInTime ?? current.check_in_time;
      if (!String(firstName).trim() || !String(lastName).trim() || !checkInTime) return Response.json({ error: 'Names and check-in time are required' }, { status: 400 });
      this.sql.exec('UPDATE queue_entries SET first_name=?, last_name=?, appointment_time=?, check_in_time=?, status=?, updated_at=? WHERE id=?', String(firstName).trim(), String(lastName).trim(), appointmentTime, checkInTime, status, now, entryId);
      result = { id: entryId };
    } else if (request.method === 'DELETE' && Number.isInteger(entryId)) {
      this.sql.exec('DELETE FROM queue_entries WHERE id=?', entryId);
      result = { id: entryId };
    } else return Response.json({ error: 'Invalid queue mutation' }, { status: 400 });

    const response = { ok: true, result };
    this.sql.exec('INSERT INTO mutations (mutation_id,response,created_at) VALUES (?,?,?)', mutationId, JSON.stringify(response), now);
    this.broadcast({ type: 'queue.updated', mutationId });
    return Response.json(response);
  }

  webSocketMessage(ws, message) {
    try {
      const payload = JSON.parse(message);
      if (payload.action === 'ping') ws.send(JSON.stringify({ type: 'pong', id: payload.id }));
      else if (payload.action === 'refresh') ws.send(JSON.stringify({ type: 'queue.snapshot', entries: this.listEntries() }));
    } catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' })); }
  }
  webSocketClose() {}
  webSocketError() {}

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) ws.send(data);
  }

  listEntries() {
    return this.sql.exec(`SELECT id, first_name AS firstName, last_name AS lastName, appointment_time AS appointmentTime, check_in_time AS checkInTime, status, created_at AS createdAt, updated_at AS updatedAt FROM queue_entries ORDER BY CASE WHEN appointment_time IS NULL THEN 1 ELSE 0 END, appointment_time ASC, check_in_time ASC, id ASC`).toArray();
  }
}
