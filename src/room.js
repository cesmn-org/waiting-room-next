const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS queue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    appointment_time TEXT, check_in_time TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('checked_in', 'shopping')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mutations (mutation_id TEXT PRIMARY KEY, response TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pairing_requests (id TEXT PRIMARY KEY, device_code_hash TEXT NOT NULL UNIQUE, user_code_hash TEXT NOT NULL UNIQUE, permission TEXT NOT NULL CHECK (permission IN ('tv', 'tablet')), status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'exchanged')), credential TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT);
  CREATE TABLE IF NOT EXISTS device_credentials (id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, permission TEXT NOT NULL CHECK (permission IN ('tv', 'tablet')), created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT);
  CREATE TABLE IF NOT EXISTS display_message (id INTEGER PRIMARY KEY CHECK (id = 1), message TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
`;

const encoder = new TextEncoder();
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function randomUserCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}
async function hashToken(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function normalizeUserCode(value) {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

export class WaitingRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(CREATE_TABLE);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/pair' && request.method === 'POST')
      return this.createPairing(request);
    if (url.pathname === '/api/pair/status' && request.method === 'POST')
      return this.pairingStatus(request);
    if (url.pathname === '/api/pair/complete' && request.method === 'POST')
      return this.completePairing(request);
    if (url.pathname === '/api/device/check' && request.method === 'POST')
      return this.checkDevice(request);
    if (url.pathname === '/api/device/revoke-connections' && request.method === 'POST')
      return this.revokeConnections(request);
    if (url.pathname === '/api/pair/pending' && request.method === 'GET')
      return Response.json(this.pendingPairings());
    if (url.pathname === '/api/devices' && request.method === 'GET')
      return Response.json(this.listDevices());
    if (url.pathname === '/api/devices/revoke' && request.method === 'POST')
      return this.revokeDevice(request);
    if (url.pathname === '/api/pair/approve' && request.method === 'POST')
      return this.approvePairing(request, 'approve');
    if (url.pathname === '/api/pair/deny' && request.method === 'POST')
      return this.approvePairing(request, 'deny');
    if (url.pathname === '/api/pair/cancel' && request.method === 'POST')
      return this.cancelPairing(request);
    if (url.pathname === '/api/display-message' && request.method === 'GET')
      return Response.json(this.getDisplayMessage());
    if (url.pathname === '/api/display-message' && request.method === 'POST')
      return this.updateDisplayMessage(request);
    if (url.pathname === '/api/queue' && request.method === 'GET')
      return Response.json(this.listEntries());
    if (url.pathname.startsWith('/api/queue') && request.method !== 'GET')
      return this.mutate(request, url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket')
        return new Response('Expected WebSocket upgrade', { status: 426 });
      const pair = new WebSocketPair();
      const credential = request.headers.get('X-Device-Credential');
      if (credential) pair[1].serializeAttachment({ credentialHash: await hashToken(credential) });
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: 'queue.snapshot', entries: this.listEntries() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found', { status: 404 });
  }
  async createPairing(request) {
    const body = await request.json().catch(() => null);
    if (!body || !['tv', 'tablet'].includes(body.permission))
      return Response.json({ error: 'Invalid permission' }, { status: 400 });
    const deviceCode = randomToken();
    const userCode = randomUserCode();
    const now = new Date();
    const expires = new Date(now.getTime() + 600000);
    this.sql.exec(
      'INSERT INTO pairing_requests (id,device_code_hash,user_code_hash,permission,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',
      crypto.randomUUID(),
      await hashToken(deviceCode),
      await hashToken(userCode),
      body.permission,
      'pending',
      now.toISOString(),
      expires.toISOString(),
    );
    return Response.json({ deviceCode, userCode, expiresAt: expires.toISOString(), interval: 5 });
  }
  async pairingStatus(request) {
    const body = await request.json().catch(() => null);
    if (!body?.deviceCode)
      return Response.json({ error: 'Device code is required' }, { status: 400 });
    const row = this.sql
      .exec(
        'SELECT * FROM pairing_requests WHERE device_code_hash=?',
        await hashToken(body.deviceCode),
      )
      .toArray()[0];
    if (!row) return Response.json({ status: 'invalid' }, { status: 400 });
    if (row.status === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
      this.sql.exec("UPDATE pairing_requests SET status='expired' WHERE id=?", row.id);
      return Response.json({ status: 'expired' });
    }
    return Response.json({ status: row.status, permission: row.permission });
  }
  listDevices() {
    return this.sql
      .exec(
        'SELECT id, permission, created_at AS createdAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt FROM device_credentials ORDER BY created_at DESC',
      )
      .toArray();
  }
  async revokeDevice(request) {
    const body = await request.json().catch(() => null);
    if (!body?.id) return Response.json({ error: 'Credential ID is required' }, { status: 400 });
    this.sql.exec(
      'UPDATE device_credentials SET revoked_at=? WHERE id=?',
      new Date().toISOString(),
      body.id,
    );
    return Response.json({ ok: true });
  }
  pendingPairings() {
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE pairing_requests SET status='expired' WHERE status='pending' AND expires_at <= ?",
      now,
    );
    return this.sql
      .exec(
        "SELECT id, permission, status, created_at AS createdAt, expires_at AS expiresAt FROM pairing_requests WHERE status='pending' ORDER BY created_at ASC",
      )
      .toArray();
  }
  async revokeConnections(request) {
    const body = await request.json().catch(() => null);
    if (!body?.id) return Response.json({ error: 'Credential ID is required' }, { status: 400 });
    const row = this.sql
      .exec('SELECT credential_hash FROM device_credentials WHERE id=?', body.id)
      .toArray()[0];
    if (!row) return Response.json({ error: 'Credential not found' }, { status: 404 });
    const connections = this.ctx.getWebSockets();
    for (const ws of connections) {
      if (ws.deserializeAttachment()?.credentialHash === row.credential_hash)
        ws.close(4001, 'Device credential revoked');
    }
    return Response.json({ ok: true });
  }
  async checkDevice(request) {
    const body = await request.json().catch(() => null);
    const row =
      body?.credential &&
      this.sql
        .exec(
          'SELECT permission FROM device_credentials WHERE credential_hash=? AND revoked_at IS NULL',
          await hashToken(body.credential),
        )
        .toArray()[0];
    if (!row) return Response.json({ error: 'Invalid device credential' }, { status: 401 });
    this.sql.exec(
      'UPDATE device_credentials SET last_used_at=? WHERE credential_hash=?',
      new Date().toISOString(),
      await hashToken(body.credential),
    );
    return Response.json({ permission: row.permission });
  }
  async completePairing(request) {
    const body = await request.json().catch(() => null);
    const row =
      body?.deviceCode &&
      this.sql
        .exec(
          "SELECT * FROM pairing_requests WHERE device_code_hash=? AND status='approved'",
          await hashToken(body.deviceCode),
        )
        .toArray()[0];
    if (!row || Date.parse(row.expires_at) <= Date.now())
      return Response.json({ error: 'Pairing is not approved or has expired' }, { status: 400 });
    this.sql.exec(
      "UPDATE pairing_requests SET status='exchanged', credential=NULL WHERE id=?",
      row.id,
    );
    return Response.json({ credential: row.credential, permission: row.permission });
  }
  async cancelPairing(request) {
    const body = await request.json().catch(() => null);
    if (!body?.id)
      return Response.json({ error: 'Pairing request ID is required' }, { status: 400 });
    const row = this.sql
      .exec("SELECT id FROM pairing_requests WHERE id=? AND status='pending'", body.id)
      .toArray()[0];
    if (!row)
      return Response.json(
        { error: 'Pairing request not found or no longer pending' },
        { status: 404 },
      );
    this.sql.exec("UPDATE pairing_requests SET status='denied' WHERE id=?", body.id);
    return Response.json({ ok: true });
  }
  async approvePairing(request, decision) {
    const body = await request.json().catch(() => null);
    const row =
      body?.userCode &&
      this.sql
        .exec(
          "SELECT * FROM pairing_requests WHERE user_code_hash=? AND status='pending'",
          await hashToken(normalizeUserCode(body.userCode)),
        )
        .toArray()[0];
    if (!row || Date.parse(row.expires_at) <= Date.now())
      return Response.json({ error: 'Pairing code is invalid or expired' }, { status: 400 });
    if (decision === 'deny') {
      this.sql.exec("UPDATE pairing_requests SET status='denied' WHERE id=?", row.id);
      return Response.json({ ok: true });
    }
    const credential = randomToken();
    this.sql.exec(
      'INSERT INTO device_credentials (id,credential_hash,permission,created_at) VALUES (?,?,?,?)',
      crypto.randomUUID(),
      await hashToken(credential),
      row.permission,
      new Date().toISOString(),
    );
    this.sql.exec(
      "UPDATE pairing_requests SET status='approved', credential=?, approved_at=? WHERE id=?",
      credential,
      new Date().toISOString(),
      row.id,
    );
    return Response.json({ ok: true });
  }
  async mutate(request, url) {
    const mutationId = request.headers.get('X-Mutation-Id');
    if (!mutationId) return Response.json({ error: 'Mutation ID is required' }, { status: 400 });
    const prior = this.sql
      .exec('SELECT response FROM mutations WHERE mutation_id=?', mutationId)
      .toArray()[0];
    if (prior) return Response.json(JSON.parse(prior.response));
    const body = request.method === 'DELETE' ? {} : await request.json().catch(() => null);
    if (!body) return Response.json({ error: 'A valid JSON body is required' }, { status: 400 });
    const path = url.pathname.replace(/\/$/, '');
    const now = new Date().toISOString();
    const entryId = Number(path.split('/').pop());
    let result;
    if (request.method === 'DELETE' && path === '/api/queue') {
      this.sql.exec('DELETE FROM queue_entries');
      result = { cleared: true };
    } else if (request.method === 'POST' && path === '/api/queue') {
      if (!body.firstName || !body.lastName || !body.checkInTime)
        return Response.json({ error: 'Names and check-in time are required' }, { status: 400 });
      result = this.sql
        .exec(
          'INSERT INTO queue_entries (first_name,last_name,appointment_time,check_in_time,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) RETURNING id',
          body.firstName.trim(),
          body.lastName.trim(),
          body.appointmentTime || null,
          body.checkInTime,
          'checked_in',
          now,
          now,
        )
        .toArray()[0];
    } else if (request.method === 'PATCH' && Number.isInteger(entryId)) {
      const current = this.sql.exec('SELECT * FROM queue_entries WHERE id=?', entryId).toArray()[0];
      if (!current) return Response.json({ error: 'Client not found' }, { status: 404 });
      const status = body.status ?? current.status;
      if (!['checked_in', 'shopping'].includes(status))
        return Response.json({ error: 'Invalid status' }, { status: 400 });
      this.sql.exec(
        'UPDATE queue_entries SET first_name=?,last_name=?,appointment_time=?,check_in_time=?,status=?,updated_at=? WHERE id=?',
        String(body.firstName ?? current.first_name).trim(),
        String(body.lastName ?? current.last_name).trim(),
        body.appointmentTime === undefined
          ? current.appointment_time
          : body.appointmentTime || null,
        body.checkInTime ?? current.check_in_time,
        status,
        now,
        entryId,
      );
      result = { id: entryId };
    } else if (request.method === 'DELETE' && Number.isInteger(entryId)) {
      this.sql.exec('DELETE FROM queue_entries WHERE id=?', entryId);
      result = { id: entryId };
    } else return Response.json({ error: 'Invalid queue mutation' }, { status: 400 });
    const response = { ok: true, result };
    this.sql.exec(
      'INSERT INTO mutations (mutation_id,response,created_at) VALUES (?,?,?)',
      mutationId,
      JSON.stringify(response),
      now,
    );
    this.broadcast({ type: 'queue.updated', mutationId });
    return Response.json(response);
  }
  webSocketMessage(ws, message) {
    try {
      const payload = JSON.parse(message);
      if (payload.action === 'ping') ws.send(JSON.stringify({ type: 'pong', id: payload.id }));
      else if (payload.action === 'refresh')
        ws.send(JSON.stringify({ type: 'queue.snapshot', entries: this.listEntries() }));
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  }
  webSocketClose() {}
  webSocketError() {}
  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) ws.send(data);
  }
  getDisplayMessage() {
    return (
      this.sql
        .exec('SELECT message, active, updated_at AS updatedAt FROM display_message WHERE id=1')
        .toArray()[0] || { message: '', active: 0, updatedAt: null }
    );
  }
  async updateDisplayMessage(request) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.message !== 'string' || body.message.length > 500)
      return Response.json({ error: 'Message must be 500 characters or fewer' }, { status: 400 });
    const message = body.message.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const now = new Date().toISOString();
    this.sql.exec(
      'INSERT INTO display_message (id,message,active,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET message=excluded.message, active=excluded.active, updated_at=excluded.updated_at',
      message,
      body.active ? 1 : 0,
      now,
    );
    this.broadcast({ type: 'display-message.updated' });
    return Response.json(this.getDisplayMessage());
  }
  listEntries() {
    return this.sql
      .exec(
        `SELECT id,first_name AS firstName,last_name AS lastName,appointment_time AS appointmentTime,check_in_time AS checkInTime,status,created_at AS createdAt,updated_at AS updatedAt FROM queue_entries ORDER BY CASE WHEN appointment_time IS NULL THEN 1 ELSE 0 END,appointment_time ASC,check_in_time ASC,id ASC`,
      )
      .toArray();
  }
}
