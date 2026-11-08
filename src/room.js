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
  )
`;

export class WaitingRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(CREATE_TABLE);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/queue' && request.method === 'GET') {
      return Response.json(this.listEntries());
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: 'queue.snapshot', entries: this.listEntries() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws, message) {
    try {
      const payload = JSON.parse(message);
      if (payload.action === 'refresh') {
        ws.send(JSON.stringify({ type: 'queue.snapshot', entries: this.listEntries() }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  }

  webSocketClose() {}
  webSocketError() {}

  listEntries() {
    return this.sql.exec(`
      SELECT
        id,
        first_name AS firstName,
        last_name AS lastName,
        appointment_time AS appointmentTime,
        check_in_time AS checkInTime,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM queue_entries
      ORDER BY
        CASE WHEN appointment_time IS NULL THEN 1 ELSE 0 END,
        appointment_time ASC,
        check_in_time ASC,
        id ASC
    `).toArray();
  }
}
