# Realtime Multi-User App — Cloudflare Workers Architecture

## Stack

- **Cloudflare Workers** (Free plan)
- **Durable Objects** with embedded SQLite (source of truth)
- **WebSockets** via Durable Object Hibernation API
- No D1, no external database

## Core Pattern

One Durable Object instance per "room" (or per user). Each DO:
- Stores data in its own embedded SQLite (persistent, no TTL)
- Holds WebSocket connections for all clients in that room
- Broadcasts to all connected clients on every write

Clients connect via `idFromName(roomId)` so all users in the same room hit the same DO instance.

## Architecture

```
Client A ──┐
Client B ──┼── WebSocket ──► Durable Object "room-1"
Client C ──┘                  ├── SQLite (source of truth)
                               └── broadcast() to all connected Ws
```

## Durable Object: `Room`

```js
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      server.addEventListener("message", (e) => this.handleMessage(e.data));
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // REST fallback (optional)
    if (url.pathname === "/items" && request.method === "GET") {
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM items ORDER BY created_at DESC LIMIT 50")
        .rows;
      return Response.json(rows);
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── Write wrapper: all mutations go through here ───────────────
  write(sql, params, eventType) {
    this.ctx.storage.sql.exec(sql, params);
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM items WHERE id = last_insert_rowid()")
      .one();
    this.broadcast({ type: eventType, row });
    return row;
  }

  // ─── Public API (called via RPC from Worker or other DOs) ──────
  async addItem(name) {
    return this.write("INSERT INTO items (name) VALUES (?)", [name], "insert");
  }

  async updateItem(id, name) {
    this.ctx.storage.sql.exec(
      "UPDATE items SET name = ? WHERE id = ?", [name, id]
    );
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM items WHERE id = ?", [id])
      .one();
    this.broadcast({ type: "update", row });
    return row;
  }

  async deleteItem(id) {
    this.ctx.storage.sql.exec("DELETE FROM items WHERE id = ?", [id]);
    this.broadcast({ type: "delete", id });
  }

  // ─── WebSocket message handler ──────────────────────────────────
  handleMessage(data) {
    const msg = JSON.parse(data);
    switch (msg.action) {
      case "add":
        this.addItem(msg.name);
        break;
      case "update":
        this.updateItem(msg.id, msg.name);
        break;
      case "delete":
        this.deleteItem(msg.id);
        break;
    }
  }

  // ─── Broadcast to all connected clients ─────────────────────────
  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(data);
    }
  }
}
```

## Worker (entry point)

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const roomId = url.pathname.replace("/room/", "") || "default";

    const doId = env.ROOM.idFromName(roomId);
    const doStub = await env.ROOM.get(doId);

    // Proxy everything to the DO
    return doStub.fetch(new Request(request.url, request));
  },
};
```

## `wrangler.toml`

```toml
name = "realtime-app"
main = "src/worker.js"
compatibility_date = "2025-01-01"

[durable_objects]
bindings = [
  { name = "ROOM", class_name = "Room" }
]

[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"
```

## Client (browser)

```js
const roomId = "room-1";
const ws = new WebSocket(`wss://your-worker.workers.dev/room/${roomId}/ws`);

ws.onmessage = (e) => {
  const { type, row, id } = JSON.parse(e.data);
  // Update local state
  if (type === "insert") addRow(row);
  if (type === "update") updateRow(row);
  if (type === "delete") removeRow(id);
};

// Send a mutation
ws.send(JSON.stringify({ action: "add", name: "Hello" }));
```

## Key Constraints & Notes

| Constraint | Value |
|---|---|
| Max WS connections per DO instance | 32,768 |
| SQLite storage per DO instance | 1 GB (Free) / 10 GB (Paid) |
| DO invocations/day (Free) | 100,000 |
| Hibernation WS connections/day (Free) | 1,000,000 |
| Point-in-time recovery | 30 days |
| Concurrency model | Single-threaded per instance; SQLite ops are synchronous (atomic read-modify-write without locks) |

## Design Decisions

1. **DO is the source of truth** — no D1, no external DB. Eliminates network hop on writes.
2. **Write wrapper pattern** — all mutations go through `write()` which guarantees a broadcast. No trigger needed because there's no external write path.
3. **One DO per room** — `idFromName(roomId)` gives natural isolation. Scale horizontally by adding rooms, not by sharding within a room.
4. **Hibernation-friendly** — idle connections cost zero. The DO sleeps after ~10 s of inactivity and wakes on next message.

## What to Implement

- [ ] `src/worker.js` — entry point (shown above)
- [ ] `src/room.js` — Durable Object class (shown above)
- [ ] `wrangler.toml` — config (shown above)
- [ ] `public/index.html` — minimal client with WebSocket + a simple list UI
- [ ] Add `idempotency` guard: deduplicate by message ID if the same client retries
- [ ] Add a `GET /room/:id/items` REST endpoint for initial state on page load   
