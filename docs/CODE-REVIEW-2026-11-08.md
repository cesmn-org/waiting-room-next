# Code Review — node-waiting-room

**Date:** 2026-11-08
**Reviewed commit:** `efd521e` (Set interface-specific page titles)
**Scope:** `src/worker.js`, `src/room.js`, `src/access.js`, `src/client/**`, build/CI config, docs
**Audience:** implementation agent (`gpt-5.6-luna`)

---

## 0. How to use this report

Each finding has a stable ID (`B-n` bug, `S-n` security, `M-n` maintainability, `D-n` DRY,
`P-n` performance/cost, `A-n` accessibility/UX, `T-n` tooling/process). Findings carry:

- **Severity** — Critical / High / Medium / Low
- **Location** — file and current line (lines are long; most files are written as compressed
  one-liners, so line numbers are coarse — search by the quoted snippet)
- **Problem** — what is wrong and why it matters
- **Fix** — concrete, implementable change

**Recommended order of work** (each phase should leave the repo deployable):

1. **Phase 0 — Formatting & tooling** (`T-1`, `T-2`, `T-3`, `M-1`). Do this _first and alone_,
   in its own commit, with no behavior changes. Every other change is much easier afterwards.
2. **Phase 1 — Correctness bugs** (`B-1` … `B-8`).
3. **Phase 2 — Security** (`S-1` … `S-7`).
4. **Phase 3 — DRY/structure refactors** (`D-1` … `D-8`, `M-2` … `M-9`).
5. **Phase 4 — Performance/cost** (`P-1` … `P-4`).
6. **Phase 5 — Accessibility/UX and docs** (`A-1` … `A-5`, `T-4` … `T-7`).

Do not combine Phase 0 with any other phase in a single commit.

---

## 1. Executive summary

The application is small (~480 source lines) and architecturally sound: a single Durable Object
with embedded SQLite as the source of truth, a Worker acting as the auth/routing edge, and one
React bundle serving four interfaces (`/tv`, `/tablet`, `/intake`, `/admin`). Mutation
idempotency via `X-Mutation-Id`, hashed device credentials, and hibernation-capable WebSockets
are all good decisions that match `docs/ACRCHITECTURE-OVERVIEW.md`.

The dominant problem is **not** architecture — it is **presentation and density**. Nearly every
source file is written as extremely long single lines (`src/room.js` is 64 lines but 14.5 KB;
`src/client/App.tsx` is 145 lines but 31 KB, with individual lines of 2,600+ characters). This
one stylistic choice is the root cause of most of the maintainability findings below: it defeats
code review, makes `git blame`/diffs useless, hides dead code, and makes the duplicated auth
guards and duplicated JSX impossible to notice.

Beyond formatting, the highest-value items are:

- **`B-1`** — `/api/pair/deny` is routed by the Worker but has no handler in the Durable Object;
  denying a device 404s.
- **`S-1`** — Paired tablets can clear the entire queue and delete any client; device
  credentials are not scoped to least privilege.
- **`S-2`** — Every 401 response carries an `X-Waiting-Room-Auth-Debug` header exposing internal
  Access configuration state to unauthenticated callers.
- **`S-3`** — The JWKS cache has no TTL and caches rejected/poisoned promises, so Access key
  rotation silently breaks all staff auth until the isolate is recycled.
- **`P-1`** — A 1-second heartbeat with a 500 ms timeout keeps every Durable Object permanently
  awake, defeating hibernation and inflating duration billing, while also causing spurious
  "Connection lost" banners on mobile networks.
- **`B-5`** — Intake cannot delete clients, and `onStatus`/`onDelete` are passed but never
  destructured, so a documented requirement is unimplemented and the dead props hide it.

No tests, linting, formatting config, or README exist, and all dependencies are pinned to
`"latest"`, so builds are not reproducible.

---

## 2. Correctness bugs

### B-1 — `/api/pair/deny` has no Durable Object handler (Critical)

**Location:** `src/worker.js` ~line 82 (`'/api/pair/approve' || url.pathname === '/api/pair/deny'`);
`src/room.js` ~line 31 (route table) and ~line 56 (`approvePairing(request, decision)`).

**Problem:** The Worker authenticates and forwards `/api/pair/deny` to the Durable Object, but
`WaitingRoom.fetch` only registers `/api/pair/approve`. A deny request therefore falls through
to `return new Response('Not found', { status: 404 })`. `approvePairing` already accepts a
`decision` parameter and implements the `'deny'` branch, but it is only ever invoked with the
hard-coded literal `'approve'`, so that branch is unreachable dead code. The client's
`decide(code, 'deny')` path in `DeviceAccessPanel` consequently cannot work (today it is only
called with `'approve'`, which masks the bug).

**Fix:** Register the route and pass the decision through:

```js
if (url.pathname === '/api/pair/approve' && request.method === 'POST')
  return this.approvePairing(request, 'approve');
if (url.pathname === '/api/pair/deny' && request.method === 'POST')
  return this.approvePairing(request, 'deny');
```

Then either surface a Deny control in `DeviceAccessPanel` or, if deny is genuinely out of scope,
delete the `deny` route from `worker.js`, drop the `decision` parameter from `approvePairing`,
and remove the dead branch. **Do not leave the current half-wired state.** Prefer wiring it up:
`cancelPairing` already provides the "reject a pending request" UX, so deny-by-code is the
natural pairing-screen counterpart.

---

### B-2 — New-entry ID is read with a racy `ORDER BY id DESC LIMIT 1` (High)

**Location:** `src/room.js`, in `mutate`, the `POST /api/queue` branch:
`result = this.sql.exec('SELECT id FROM queue_entries ORDER BY id DESC LIMIT 1').toArray()[0];`

**Problem:** This re-queries for "the highest id" rather than asking for the id that was just
inserted. Durable Objects serialize requests per object so this is unlikely to misfire today,
but it is semantically wrong, silently breaks if a concurrent delete/insert pattern is ever
introduced, and returns `undefined` rather than erroring if the table is empty. It also costs
an extra table scan on every check-in.

**Fix:** Use SQLite's `RETURNING` clause (supported by DO SQLite) and read the inserted row
directly:

```js
result = this.sql.exec(
  'INSERT INTO queue_entries (first_name,last_name,appointment_time,check_in_time,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) RETURNING id',
  ...
).toArray()[0];
```

If `RETURNING` proves unavailable, use `SELECT last_insert_rowid() AS id` instead — never a
`MAX(id)`-style query.

---

### B-3 — Optimistic updates read stale state from the closure (High)

**Location:** `src/client/App.tsx`, `setStatus`, `remove`, `editEntry`:
`const previous = entries; setEntries(entries.map(...))`.

**Problem:** All three mutation helpers capture `entries` from the render closure instead of
using the functional updater form. Because every mutation is optimistic and a WebSocket
`queue.updated` broadcast triggers a `refresh()` concurrently, two actions dispatched in quick
succession (a realistic tablet pattern: tap "Shop" on two clients in under a second) can cause
the second update to be computed against a snapshot that predates the first, reverting it. The
rollback path is worse: `setEntries(previous)` restores a snapshot that may be several
generations old, discarding unrelated server state.

**Fix:** Use functional updates, and roll back by targeted inverse operation rather than whole-
list restore:

```js
async function setStatus(entry: QueueEntry, status: QueueStatus) {
  const previousStatus = entry.status;
  setEntries((current) => current.map((e) => (e.id === entry.id ? { ...e, status } : e)));
  try {
    await mutateQueue('PATCH', `/api/queue/${entry.id}?device=${mode}`, { status });
  } catch {
    setEntries((current) =>
      current.map((e) => (e.id === entry.id ? { ...e, status: previousStatus } : e)),
    );
    setError('Update failed; the change was reverted.');
  }
}
```

Apply the same pattern to `remove` (re-insert the single removed entry, or simply call
`refresh()` on failure) and `editEntry` (restore only that entry's prior field values). Calling
`refresh()` on failure is the simplest correct rollback and is acceptable here since the DO is
authoritative — prefer it if the inverse-operation code gets convoluted.

---

### B-4 — Unguarded `JSON.parse` in the WebSocket message handler (Medium)

**Location:** `src/client/App.tsx`, `socket.onmessage`:
`const message = JSON.parse(event.data) as { ... }`.

**Problem:** Any non-JSON frame — including the `{"type":"error","message":"Invalid message"}`
path's counterpart, a proxy-injected frame, or a future binary frame — throws inside the event
handler. The exception escapes to the global error handler, the heartbeat/timeout state machine
is left inconsistent (`awaiting` stays set), and the 500 ms timeout then force-closes the socket,
producing a visible reconnect loop. There is also no React error boundary to contain renderer
failures.

**Fix:** Wrap the parse and ignore unparseable frames:

```js
socket.onmessage = (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    logNetwork('websocket message dropped (unparseable)');
    return;
  }
  // ...existing dispatch...
};
```

Separately, add an error boundary component around `<App />` in `main.tsx` so a render failure
on an unattended TV shows a reload prompt rather than a blank screen.

---

### B-5 — Intake cannot delete clients; `onStatus`/`onDelete` are dead props (Medium)

**Location:** `src/client/App.tsx` — `<Intake ... onStatus={setStatus} onDelete={remove} ... />`
vs. `function Intake({ entries, onAdded, onEdit, onClear, userEmail, error, connected }: {...})`.

**Problem:** `Intake`'s prop _type_ declares `onStatus` and `onDelete`, and the call site passes
both, but the destructuring pattern omits them, so they are silently unused. As a result
`remove()` is never reachable from the UI and `docs/WAITING-ROOM-REQUIREMENTS.md` ("Allows
deleting clients from the queue… Deletion is permanent") is unimplemented. The `EditModal` has
no delete affordance either. Status changes from intake are likewise unavailable, though
`EditModal`'s Status `<select>` covers that need via `onEdit`.

**Fix:** Implement deletion — add a **Delete** button to `EditModal`'s action row (guarded by
`window.confirm`, styled `danger-button`) that calls a new `onDelete` prop, and destructure
`onDelete` in `Intake`. Then remove `onStatus` from both the type and the call site, since
`onEdit` already covers status edits from intake. After this change no declared prop should be
undestructured; enabling `noUnusedLocals`/`noUnusedParameters` (see `T-3`) will enforce it.

---

### B-6 — `isHumanRoute` is computed and never used (Low)

**Location:** `src/worker.js` ~line 41.

**Problem:** `const isHumanRoute = url.pathname === '/api/session' || ...` is dead. It appears to
be a leftover from an earlier auth design. Dead conditionals in an auth file are actively
harmful: a future reader may assume routes are gated by it.

**Fix:** Delete the line. If the intent was "these routes require a human identity, never a
device credential," express that in the route table produced by `D-1` instead.

---

### B-7 — `checkDevice` hashes the credential twice per request (Low)

**Location:** `src/room.js`, `checkDevice` — `await hashToken(body.credential)` appears in both
the `SELECT` and the subsequent `UPDATE ... WHERE credential_hash=?`.

**Problem:** Two SHA-256 digests per device request where one suffices. Minor on its own, but
`checkDevice` is on the hot path for _every_ device-authenticated request (see `P-2`).

**Fix:** Hash once into a local `const credentialHash` and reuse it in both statements.

---

### B-8 — `pairingStatus === 'revoked'` is unreachable (Low)

**Location:** `src/client/App.tsx` — the "Access revoked" screen guarded by
`pairingStatus === 'revoked'`.

**Problem:** No code path ever sets `pairingStatus` to `'revoked'`. The WebSocket close handler
for code `4001` (the revocation close code sent by `revokeConnections`) sets it to `'starting'`
and bumps `pairingAttempt`, which re-enters pairing immediately. So the revoked screen is dead
code, and a revoked device silently jumps straight to a fresh pairing code with no explanation
of what happened.

**Fix:** On close code `4001`, set `pairingStatus` to `'revoked'` and do **not** auto-bump
`pairingAttempt`; let the existing "Try again" button (extend its `['denied','expired','error']`
list to include `'revoked'`) drive re-pairing. Also move the pairing-status strings into a
single `const PAIRING_MESSAGES: Record<PairingStatus, string>` map and type `pairingStatus` as a
union rather than `string` — the current nested ternary chain in the pairing screen is where
this bug hid.

---

## 3. Security

### S-1 — Paired tablets have full mutation authority, including "clear queue" (High)

**Location:** `src/worker.js`, the queue/WebSocket block:
`if (isMutation && permission !== 'tablet') return forbidden();`

**Problem:** The only check applied to a device-authenticated mutation is "is this a tablet."
A tablet credential can therefore issue `DELETE /api/queue` (wipe the entire queue),
`DELETE /api/queue/:id` (permanently delete any client), and `PATCH /api/queue/:id` with
arbitrary `firstName`/`lastName`/`appointmentTime`/`checkInTime`. Per the requirements doc the
tablet's job is strictly "call a checked-in client to shop" and "undo" — i.e. status transitions
only. A tablet is a physically exposed, unattended device in a public-facing room whose
credential lives in a one-year cookie, so it is precisely the credential that should be most
narrowly scoped. Today the blast radius of a stolen tablet cookie is irreversible destruction of
all operational data.

**Fix:** Enforce least privilege at the Worker edge. Introduce an explicit capability table and
check method + path + body shape, not just the permission name:

```js
// Devices with the 'tablet' permission may only transition status on an existing entry.
if (permission === 'tablet') {
  const isStatusPatch = request.method === 'PATCH' && /^\/api\/queue\/\d+$/.test(url.pathname);
  if (!isStatusPatch) return forbidden();
}
```

and additionally have the Durable Object reject any `PATCH` carrying fields other than `status`
when the request arrives with an `X-Device-Credential` header (the Worker already forwards it).
Defense in depth matters here because the DO is the only component that can see the body.
Devices with `tv` permission must remain read-only, which the current code does achieve.

---

### S-2 — 401 responses leak Access configuration state to anyone (High)

**Location:** `src/worker.js`, `unauthorized()` — `response.headers.set('X-Waiting-Room-Auth-Debug', JSON.stringify({...}))`.

**Problem:** Every unauthenticated 401 includes a header enumerating which Access secrets are
configured (`teamDomainConfigured`, `audienceConfigured`, `adminEmailConfigured`,
`intakeEmailConfigured`), whether a JWT header or cookie was present, and the full
`accessDiagnostics` object including the precise validation failure reason
(`issuer-mismatch`, `audience-mismatch`, `signing-key-not-found`, `signature-invalid`,
`email-missing`, or a 80-character slice of an internal exception message). This is a textbook
authentication oracle: it tells an attacker exactly which half of a forged token to fix next,
and it confirms deployment misconfiguration to unauthenticated probes. `accessDiagnostics` also
costs a full second JWT validation pass on every 401.

**Fix:** Gate the diagnostics header behind an explicit, default-off environment flag and never
ship it to production:

```js
if (env.AUTH_DEBUG === 'true' && request && env) {
  /* set header */
}
```

Better: drop the header entirely and emit the same object via `console.log` so it lands in
`wrangler tail` / Workers Logs, visible to operators but not to clients. Then delete the now-
unused `accessDiagnostics` export from `access.js` and collapse `validate`'s `result` bookkeeping
(the ~12-field object threaded through every early return) into plain failure strings — that
object exists solely to feed this header and is responsible for much of `access.js`'s density.

---

### S-3 — JWKS cache never expires and caches poisoned promises (High)

**Location:** `src/access.js`, `getKeys()` and `const jwksCache = new Map()`.

**Problem:** Two distinct defects in eight lines:

1. **No TTL.** Once fetched, Cloudflare Access signing keys are cached for the lifetime of the
   isolate. Access rotates these keys. After rotation, `keys.keys?.find(key => key.kid === header.kid)`
   returns `undefined`, `result.failure = 'signing-key-not-found'`, and **all staff
   authentication fails** until the isolate happens to be recycled — with no alarm and a failure
   mode (`403`-ish 401 loops on `/intake` and `/admin`) that looks like an Access
   misconfiguration rather than a cache bug.
2. **Poisoned cache.** The _promise_ is inserted into the map before it settles, and a rejected
   promise is never evicted. A single transient JWKS fetch failure (or a non-`ok` response, which
   throws `JWKS HTTP ${status}`) is cached permanently, and every subsequent validation awaits
   that same rejected promise. The rejection is swallowed by `validate`'s `catch`, producing an
   opaque `failure` of `"JWKS HTTP 503"` forever.

**Fix:**

```js
const JWKS_TTL_MS = 3_600_000;
const jwksCache = new Map(); // teamDomain -> { expiresAt, promise }

async function getKeys(teamDomain) {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = fetch(`${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`).then(
    async (response) => {
      if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
      return response.json();
    },
  );
  promise.catch(() => jwksCache.delete(teamDomain)); // never cache a failure
  jwksCache.set(teamDomain, { expiresAt: Date.now() + JWKS_TTL_MS, promise });
  return promise;
}
```

Additionally, on `signing-key-not-found`, evict the cache entry and retry **once** before
failing — this makes key rotation self-healing rather than requiring isolate recycling.

---

### S-4 — Approved pairing credentials are stored in plaintext (Medium)

**Location:** `src/room.js` — `pairing_requests.credential TEXT`, written by `approvePairing`
(`SET status='approved', credential=?`) and read by `completePairing`.

**Problem:** `device_credentials` correctly stores only `credential_hash`, but the pairing
handshake parks the raw credential in `pairing_requests.credential` between approval and
exchange. The window is bounded (the row must still be within its 10-minute `expires_at`, and
`completePairing` nulls the column on exchange), and the DO's SQLite is not externally readable,
so this is Medium rather than High. But it is an unnecessary plaintext-secret-at-rest: if the
device never completes the exchange, the row retains the live credential until the never-
implemented cleanup (see `P-3`) removes it — which is to say, forever.

**Fix:** Preferred: do not mint the credential at approval time. Have `approvePairing` only set
`status='approved'`, and have `completePairing` generate the token, insert the
`device_credentials` row, and return the plaintext exactly once — so the secret exists only in
the response body. If the current flow must be kept, add an `alarm()`-driven sweep that nulls
`credential` for any non-`pending`/non-`approved` or expired row, and null it on the `expired`
transition in `pairingStatus` and `pendingPairings`.

---

### S-5 — No rate limiting or attempt cap on pairing approval (Medium)

**Location:** `src/room.js`, `approvePairing`; `src/worker.js`, `/api/pair/approve`.

**Problem:** `/api/pair/approve` accepts unlimited `userCode` guesses from any authenticated
staff session, and `/api/pair/status` accepts unlimited `deviceCode` polls from _unauthenticated_
callers. The user-code keyspace (32⁸ ≈ 1.1×10¹²) makes blind guessing impractical, and approval
requires staff auth, so this is not currently exploitable — but `/api/pair/status` is an
unauthenticated, unthrottled endpoint that performs a SHA-256 and a DB read per call, which is a
cheap amplification target (see also `P-4`).

**Fix:** Add an `attempts` counter column to `pairing_requests` and expire a request after ~10
failed status polls or approval mismatches. For `/api/pair/status`, enforce the advertised
`interval` server-side: record `last_polled_at` and return `429` for polls arriving faster than
the interval. Consider Cloudflare Rate Limiting rules on `/api/pair*` as a complementary edge
control.

---

### S-6 — WebSocket frames are logged verbatim, including client names (Medium)

**Location:** `src/client/App.tsx` — `logNetwork('websocket message', message)` and
`logNetwork('queue response', { count })`; also `logNetwork('session response', { ..., body })`.

**Problem:** `queue.snapshot` frames contain the full entry list — first names, last names,
appointment times, check-in times — and these are written to the browser console on every
snapshot. The TV is a public, often-unattended screen; the tablet is shared. Anyone who opens
devtools (or a browser extension with console access, or a crash reporter) harvests the roster.
The session logger additionally dumps the raw response body containing the staff email address.

**Fix:** Make `logNetwork` a no-op unless `import.meta.env.DEV`, and never pass entry payloads to
it — log shapes and counts only (`{ type: message.type, count: message.entries?.length }`).
Redact the session body: log `response.status` and `ok`, not `body`. The three raw
`console.error`/`console.warn`/`console.info` calls scattered through `App.tsx` and
`DeviceAccessPanel` ("pairing cancel response" logs the whole body text) should route through the
same gated helper so there is exactly one logging policy.

---

### S-7 — Error messages are surfaced raw to the UI (Low)

**Location:** `src/client/App.tsx`, `cancelPairing` —
``throw new Error(`Unable to cancel pairing request (${response.status}): ${body || 'no response body'}`)`` ,
rendered into `<p className="error">`.

**Problem:** Server status codes and raw response bodies are rendered into the DOM. Combined with
`S-2`, an operator-visible panel becomes a diagnostic surface. It is also poor UX — staff see
`(404): {"error":"Pairing request not found or no longer pending"}` instead of a sentence.

**Fix:** Keep the detail in the (dev-gated) console and show a human message: "This pairing
request is no longer pending. Refreshing…" then call `load()`. Build a small
`errorMessage(error, fallback)` helper — the `error instanceof Error ? error.message : '…'`
ternary is repeated **seven** times in `App.tsx` (see `D-5`).

---

## 4. Maintainability

### M-1 — Source is written as compressed one-liners (Critical, do first)

**Location:** Every file in `src/`. Representative metrics:

| File                    | Lines |  Bytes | Longest line |
| ----------------------- | ----: | -----: | -----------: |
| `src/client/App.tsx`    |   145 | 31,236 |        2,637 |
| `src/room.js`           |    64 | 14,560 |        2,725 |
| `src/client/styles.css` |    45 | 11,118 |            — |
| `src/worker.js`         |   137 |  7,759 |          468 |
| `src/access.js`         |    49 |  4,346 |          372 |

**Problem:** This is the single highest-leverage finding in the report. Multi-statement lines
(`const cached = jwksCache.get(teamDomain); if (cached) return cached;`), whole functions on one
line, and 2,700-character JSX expressions mean:

- Diffs and `git blame` are per-file, not per-statement — review is effectively impossible.
- Stack traces and error messages collapse to "line 57", pointing at ~15 logical statements.
- Dead code (`B-6`, `B-8`), duplicated guards (`D-1`), and unused props (`B-5`) are invisible.
- Debugger breakpoints cannot be set on individual statements.
- Mixed quote styles (`'` in `src/*.js`, `"` after any Prettier pass) will churn every file on
  the first format.

**Fix:** Add Prettier and format the entire tree in **one commit that contains nothing else**,
then record that commit in `.git-blame-ignore-revs` so history stays navigable:

```jsonc
// .prettierrc
{ "printWidth": 100, "singleQuote": true, "semi": true, "trailingComma": "all" }
```

```bash
npm i -D prettier
npx prettier --write "src/**/*.{js,ts,tsx,css}" "*.{json,ts}" "docs/**/*.md"
git commit -am "Format source with Prettier"
git rev-parse HEAD >> .git-blame-ignore-revs
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

Add `"format": "prettier --write ."` and `"format:check": "prettier --check ."` scripts, and run
`format:check` in CI (`T-2`). Keep `singleQuote: true` to minimize churn against the existing
`src/*.js` style.

---

### M-2 — `App.tsx` is a 1,200-line (formatted) module with ten components (High)

**Location:** `src/client/App.tsx`.

**Problem:** One file holds: four time/name formatting utilities, `Clock`, `QueueList`,
`Connection`, `logNetwork`, the `App` root with five `useEffect` hooks (device pairing state
machine, session fetch, WebSocket lifecycle with heartbeat, title, derived lists),
`DisplayMessageMenu`, `DisplayMessagePanel`, `DeviceAccessMenu`, `DeviceCodeInput`,
`DeviceAccessPanel`, `Intake`, and `EditModal` — plus three local type declarations duplicating
server shapes. The WebSocket effect alone declares eight mutable locals (`retry`, `heartbeat`,
`timeout`, `socket`, `stopped`, `reconnectImmediately`, `heartbeatId`, `awaiting`) and three
nested closures.

**Fix:** Split along these seams (directories, not a flat dump):

```
src/client/
  App.tsx                    # mode routing + composition only
  modes.ts                   # Mode union, pathname -> mode, titles
  hooks/
    useQueueSocket.ts        # socket + heartbeat + reconnect -> { entries, connected }
    useDevicePairing.ts      # pairing state machine -> { deviceReady, pairingCode, pairingStatus, retry }
    useStaffSession.ts       # /api/session -> { userEmail, sessionChecked, error }
    useDisplayMessage.ts     # load/save/toggle display message
  components/
    Clock.tsx  Connection.tsx  QueueList.tsx  SideMenu.tsx
    DeviceCodeInput.tsx  DeviceAccessPanel.tsx  DisplayMessagePanel.tsx
    EditModal.tsx  Intake.tsx
  lib/
    time.ts                  # localTimeValue, formatCheckInTime, formatAppointmentTime, formatDateTime, appointmentTimes
    log.ts                   # dev-gated logNetwork
    http.ts                  # fetchJson helper (see D-5)
```

Extracting `useQueueSocket` and `useDevicePairing` as custom hooks is the highest-value part:
both are self-contained state machines that are currently inlined into the component body, and
both become independently testable once extracted.

---

### M-3 — Shared API types are declared twice and drift from the server (Medium)

**Location:** `src/client/App.tsx` (`PairingRequest`, `DeviceCredential`, `DisplayMessage`) vs.
`src/room.js` (`listDevices`, `pendingPairings`, `getDisplayMessage` column aliases);
`src/client/types.ts` (`QueueEntry`).

**Problem:** The client hand-maintains types for DO responses. They already disagree in spirit:
`DisplayMessage.active` is typed `number` because SQLite stores 0/1, and the client then calls
`Boolean(value.active)` in four places. `PairingRequest` omits `status`, which
`pendingPairings` does return. Nothing detects drift — `src/*.js` is excluded from `tsconfig`'s
`include`, and `allowJs` is `false`, so the server is entirely untyped.

**Fix:** Create `src/shared/types.ts` as the single source of truth for `QueueEntry`,
`QueueStatus`, `DevicePermission` (`'tv' | 'tablet'`), `PairingStatus`, `PairingRequest`,
`DeviceCredential`, and `DisplayMessage`, and import it from both sides. Normalize `active` to a
boolean once, at the DO boundary (`active: Boolean(row.active)` in `getDisplayMessage`), so the
`Boolean(...)` calls disappear from the client. Longer term, migrate `src/*.js` to TypeScript
and add them to `tsconfig.include` — the files are small and this would have caught `B-1`,
`B-5`, and `B-6`.

---

### M-4 — Permission and status string literals are scattered (Medium)

**Location:** `'tv'`/`'tablet'` appear ~30 times across `worker.js`, `room.js`, and `App.tsx`;
`'admin'`/`'intake'` appear in five separate `['admin','intake'].includes(role)` checks in
`worker.js`; `'checked_in'`/`'shopping'` appear in `room.js` (twice in SQL `CHECK`, once in a
validation array), `types.ts`, and four places in `App.tsx`.

**Problem:** Adding a role or status requires finding every literal. The status list is encoded
three times in `room.js` alone (the `CREATE TABLE` `CHECK` constraint, the `PATCH` validation
array, and the `INSERT` default), so they can silently diverge — a `CHECK` violation would
surface as an unhandled SQLite error and a 500 rather than a 400.

**Fix:** Define the vocabularies once in `src/shared/types.ts` and derive everything from them:

```ts
export const DEVICE_PERMISSIONS = ['tv', 'tablet'] as const;
export const STAFF_ROLES = ['admin', 'intake'] as const;
export const QUEUE_STATUSES = ['checked_in', 'shopping'] as const;
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number];
export type StaffRole = (typeof STAFF_ROLES)[number];
export type QueueStatus = (typeof QUEUE_STATUSES)[number];
```

Use `DEVICE_PERMISSIONS.includes(x)` / `STAFF_ROLES.includes(role)` / `QUEUE_STATUSES.includes(status)`
everywhere, and generate the SQL `CHECK` lists from the same constants when building
`CREATE_TABLE` so they cannot drift.

---

### M-5 — `WaitingRoom` does not extend `DurableObject` and discards `env` (Medium)

**Location:** `src/room.js` — `export class WaitingRoom { constructor(ctx) { ... } }`.

**Problem:** The class ignores the modern `DurableObject` base class documented in
`docs/ACRCHITECTURE-OVERVIEW.md` (`export class Room extends DurableObject`) and drops the `env`
argument entirely. Consequences: no `this.env` (so the DO can never read configuration or call
bindings), no base-class niceties, and divergence from the project's own architecture doc. The
`CREATE_TABLE` DDL also runs on **every** constructor invocation rather than once.

**Fix:**

```js
import { DurableObject } from 'cloudflare:workers';

export class WaitingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.#migrate());
  }
}
```

Move schema creation into a `#migrate()` method guarded by `blockConcurrencyWhile` and a
`PRAGMA user_version` check, so DDL runs once per object rather than per isolate start. This also
gives you a real migration path — currently there is none, and `CREATE TABLE IF NOT EXISTS`
silently ignores any column added to the DDL later. Note the existing
`[[migrations]] tag = "v1"` in `wrangler.toml` covers only the DO class registration, not schema.

---

### M-6 — `unauthorized()` has an awkward, error-prone signature (Low)

**Location:** `src/worker.js` —
`async function unauthorized(message = 'Authentication required', request, env)`.

**Problem:** A defaulted parameter precedes two required-in-practice ones, so callers must always
pass all three, and `if (request && env)` exists only to tolerate the two call sites that don't
(`'Device pairing required'` in `/api/pair/session`). Nine call sites repeat near-identical
message strings, three of which are the verbatim 60-character literal
`'Valid Cloudflare Access authentication required'`.

**Fix:** Reorder to `unauthorized(request, env, message = 'Authentication required')` and hoist
the repeated messages into named constants (`AUTH_REQUIRED`, `PAIRING_REQUIRED`). Most call sites
disappear entirely once `D-1` lands.

---

### M-7 — Route matching is stringly-typed and inconsistently normalized (Low)

**Location:** `src/worker.js` —
`const displayMessagePath = url.pathname.replace(/\/$/, '') === '/api/display-message'`;
`src/room.js` — `if (url.pathname === '/api/display-message' && ...)` and
`const path = url.pathname.replace(/\/$/, '')` inside `mutate`.

**Problem:** Trailing-slash normalization is applied in three places with three different scopes:
the Worker normalizes only `/api/display-message`, the DO normalizes only inside `mutate`, and
every other comparison is exact. So `POST /api/display-message/` passes the Worker's auth gate
and then 404s at the DO (the bug commit `6d21b0c "Normalize display message route"` fixed one
half of this). `/api/queue/` vs `/api/queue` and `/api/devices/` behave inconsistently too. The
misleadingly-named boolean `displayMessagePath` holds a boolean, not a path.

**Fix:** Normalize once, at the top of both `fetch` handlers:
`const path = url.pathname.replace(/\/+$/, '') || '/';` and compare `path` everywhere. Delete the
per-site `replace` calls and rename `displayMessagePath` → `isDisplayMessage`. This folds
naturally into the route table from `D-1`.

---

### M-8 — Magic numbers throughout (Low)

**Location:** `appointmentTimes = Array.from({ length: 58 }, ...)` with `13 * 60 + index * 5`
(`App.tsx`); `600000` pairing TTL and `interval: 5` (`room.js`); `Max-Age=31536000` (`worker.js`);
heartbeat `1000`/`500` and reconnect `500`/`0` (`App.tsx`); `approved` flash `1200` (`App.tsx`);
`message.length > 500` and `maxLength={500}` (`room.js` / `App.tsx`); `payload.nbf > now + 30`
(`access.js`); `.slice(0, 80)` (`access.js`); code length `8` (five places).

**Problem:** `58`, `13 * 60`, and `5` jointly encode "appointment slots run 1:00 PM to 5:45 PM in
5-minute steps" — a business rule that is nowhere stated and cannot be changed confidently. The
500-character message cap is duplicated across the client and server with no shared constant, so
they can drift and produce a silent 400.

**Fix:** Name them. Put operational policy in one `src/shared/config.ts`:

```ts
export const APPOINTMENT_START_HOUR = 13;
export const APPOINTMENT_END_HOUR = 18;
export const APPOINTMENT_SLOT_MINUTES = 5;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_POLL_SECONDS = 5;
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const DISPLAY_MESSAGE_MAX_LENGTH = 500;
export const USER_CODE_LENGTH = 8;
```

Derive `appointmentTimes` from the first three, and import `DISPLAY_MESSAGE_MAX_LENGTH` and
`USER_CODE_LENGTH` on both sides.

---

### M-9 — `QueueDraft` is exported but never used (Low)

**Location:** `src/client/api.ts`, final line.

**Problem:** Dead export. `mutateQueue` takes `Record<string, unknown>`, so mutation bodies are
entirely unchecked — the type that _should_ constrain them exists but is unreferenced. Typos in
body keys (`appointmentTime` vs `appointment_time`) fail silently at runtime.

**Fix:** Either delete it, or (better) use it to type the API surface properly — replace the
single stringly-typed `mutateQueue(method, path, body)` with intention-revealing functions:

```ts
export const createEntry = (draft: QueueDraft) => mutateQueue('POST', '/api/queue', draft);
export const updateEntry = (id: number, patch: Partial<QueueDraft>) =>
  mutateQueue('PATCH', `/api/queue/${id}`, patch);
export const deleteEntry = (id: number) => mutateQueue('DELETE', `/api/queue/${id}`);
export const clearQueue = () => mutateQueue('DELETE', '/api/queue');
```

This removes hand-built template-literal URLs (including the stray `?device=${mode}` in
`setStatus`, which no other mutation sends — an inconsistency worth resolving while you're here).

---

## 5. DRY opportunities

### D-1 — Five identical staff-auth guards in the Worker (High)

**Location:** `src/worker.js` — the blocks for `/api/devices/revoke`, `/api/devices`,
`/api/pair/pending`, `/api/pair/cancel`, and `/api/pair/approve|deny` each open with the
identical two lines:

```js
if (!identity || !role)
  return unauthorized('Valid Cloudflare Access authentication required', request, env);
if (!['admin', 'intake'].includes(role)) return forbidden();
```

**Problem:** The same four-element predicate is written five times. `/api/pair/pending` and
`/api/pair/cancel` are byte-identical three-line blocks differing only in the path string. This
is the most dangerous kind of duplication: a future role change (say, restricting device
revocation to `admin` only) must be applied five times, and missing one is a silent
authorization hole. The `fetch` handler is a 100-line `if`-ladder in which the auth policy is
interleaved with proxying mechanics, so the policy cannot be read as a whole or tested.

**Fix:** Replace the ladder with a declarative route table and one generic dispatcher:

```js
const ROUTES = [
  { path: '/api/pair', methods: ['POST'], auth: 'public' },
  { path: '/api/pair/status', methods: ['POST'], auth: 'public' },
  { path: '/api/pair/complete', methods: ['POST'], auth: 'public', onSuccess: setDeviceCookie },
  { path: '/api/pair/session', methods: ['GET'], auth: 'device' },
  { path: '/api/pair/pending', methods: ['GET'], auth: 'staff' },
  { path: '/api/pair/cancel', methods: ['POST'], auth: 'staff' },
  { path: '/api/pair/approve', methods: ['POST'], auth: 'staff', withRoleHeader: true },
  { path: '/api/pair/deny', methods: ['POST'], auth: 'staff', withRoleHeader: true },
  { path: '/api/devices', methods: ['GET'], auth: 'staff' },
  { path: '/api/devices/revoke', methods: ['POST'], auth: 'staff', onSuccess: revokeConnections },
  { path: '/api/display-message', methods: ['GET', 'POST'], auth: 'staffOrTv' },
];
```

with a single `authorize(kind, { identity, role, request, env })` helper returning
`{ ok, permission } | Response`. Keep the queue/WebSocket block separate (its mutation rules are
genuinely different — see `S-1`), but express it as one more entry with a dedicated `auth: 'queue'`
kind. The handler shrinks to roughly 40 lines and the entire authorization policy becomes a
table you can read in one screen and unit-test row by row.

---

### D-2 — `request.json().catch(() => null)` + body validation repeated 9× (High)

**Location:** `src/room.js` — every one of `createPairing`, `pairingStatus`, `revokeDevice`,
`revokeConnections`, `checkDevice`, `completePairing`, `cancelPairing`, `approvePairing`,
`updateDisplayMessage` begins with `const body = await request.json().catch(() => null);` followed
by a bespoke presence check and a hand-written `Response.json({ error: '…' }, { status: 400 })`.

**Problem:** Nine copies of the same parse-then-validate-then-error-shape sequence. Three of them
use the awkward `const row = body?.field && this.sql.exec(...)` idiom, whose result is
`undefined | false | row` — a three-state value that works only because `if (!row)` catches both
falsy cases, and which would silently misbehave if a column were ever named `0` or `''`. Error
response construction (`Response.json({ error }, { status })`) appears ~15 times across the two
server files.

**Fix:** Add small helpers at the top of `room.js`:

```js
const jsonError = (error, status = 400) => Response.json({ error }, { status });

async function readJson(request) {
  const body = await request.json().catch(() => null);
  return body && typeof body === 'object' ? body : null;
}

function requireFields(body, ...fields) {
  if (!body) return 'A valid JSON body is required';
  const missing = fields.filter((field) => !body[field]);
  return missing.length ? `Missing required field(s): ${missing.join(', ')}` : null;
}
```

Each handler then opens with three readable lines, and the `body?.x && sql.exec(...)` idiom is
replaced by an explicit early return followed by a plain query.

---

### D-3 — Hex encoding written three times (Medium)

**Location:** `src/room.js` — the expression
`[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')` appears in `randomToken`
and in `hashToken` (over `new Uint8Array(digest)`); `randomUserCode` repeats the same
`[...bytes].map(...).join('')` shape with a different alphabet.

**Fix:** `const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');`
then `randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)))` and
`hashToken = async (v) => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(v)))`.
Note `randomUserCode`'s `byte % alphabet.length` introduces modulo bias (256 % 32 === 0, so with
a 32-character alphabet it happens to be unbiased — add a comment asserting this invariant, or
use rejection sampling so the code survives an alphabet change).

---

### D-4 — Cookie parsing duplicated between Worker and Access module (Medium)

**Location:** `src/access.js`, `accessCookie()`; `src/worker.js`, `cookie()`. Both implement
`request.headers.get('Cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith(name + '='))`
with slightly different extraction (`decodeURIComponent(...slice(len))` vs `slice(len + 1) || null`).

**Fix:** Extract `src/shared/cookies.js` exporting
`getCookie(request, name): string | null` that trims, matches exactly on `name=`, and
URI-decodes. Have both call sites use it. This also fixes a latent inconsistency: the Worker does
_not_ `decodeURIComponent` the device credential while `access.js` does decode its cookie, so a
credential containing `%` would mismatch (currently impossible since credentials are hex, but
fragile).

---

### D-5 — `fetch` → check `ok` → parse → `instanceof Error` repeated ~8× in the client (High)

**Location:** `src/client/App.tsx` — `loadDisplayMessage`, the session effect, `DisplayMessagePanel`'s
load/`save`/`toggle`, `DeviceAccessPanel`'s `load`/`cancelPairing`/`decide`/`revoke`. Each
hand-writes `fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) })`,
then `if (!response.ok) throw new Error(...)`, then `await response.json()`, then
`error instanceof Error ? error.message : 'fallback'`.

**Problem:** The literal `headers: { 'Content-Type': 'application/json' }` appears **nine** times
in `App.tsx` alone (plus twice more in the pairing effect). The
`instanceof Error ? .message : 'fallback'` ternary appears **seven** times. `save` and `toggle` in
`DisplayMessagePanel` are 95% identical — both POST `{ message, active }` and then run the
identical five-line "apply the response to local state" block, which itself appears a third time
in the load effect.

**Fix:** Add `src/client/lib/http.ts`:

```ts
export async function fetchJson<T>(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new HttpError(response.status, detail?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
```

Then collapse `save`/`toggle` into one `persist({ message, active })` that both call, with the
shared state-application block extracted to `applyDisplayMessage(value)`. Fold all of this into
the `useDisplayMessage` hook from `M-2`.

---

### D-6 — The "Shop 🛒 →" button and `QueueList` call are duplicated (Medium)

**Location:** `src/client/App.tsx`, the TV/tablet return block — the `<QueueList>` elements for
"Appointments" and "Walk-ins" are character-for-character identical except for `title` and
`entries`, including the 5-line conditional `action` render prop building the same
`<button className="shop-btn" onClick={() => setStatus(e, 'shopping')}>Shop 🛒 →</button>`.

**Fix:**

```tsx
const shopAction =
  mode === 'tablet'
    ? (entry: QueueEntry) => <ShopButton entry={entry} onShop={setStatus} />
    : undefined;

{
  [
    { title: 'Appointments', entries: appointments },
    { title: 'Walk-ins', entries: walkIns },
  ].map(({ title, entries: list }) => (
    <QueueList
      key={title}
      title={title}
      entries={list}
      details={mode === 'tablet'}
      action={shopAction}
    />
  ));
}
```

---

### D-7 — The two intake table bodies are duplicated (Medium)

**Location:** `src/client/App.tsx`, `Intake` — `entries.filter(e => e.appointmentTime).map(...)`
and `entries.filter(e => !e.appointmentTime).map(...)` render ~20 identical lines each, differing
only in the appointment cell (`formatAppointmentTime(entry.appointmentTime!)` vs the literal
`'Walk-in'`). The status-badge markup
(`<span className={\`status-badge status-${entry.status}\`}>{entry.status === 'checked_in' ? 'Checked in' : 'Shopping'}</span>`)
appears in both copies. The non-null assertion `entry.appointmentTime!` is a smell the split
creates.

**Fix:** Extract `<IntakeRow entry={entry} connected={connected} onEdit={setEditing} />` and have
it render `entry.appointmentTime ? formatAppointmentTime(entry.appointmentTime) : 'Walk-in'`,
eliminating the `!` assertion. Extract `<StatusBadge status={entry.status} />` with a
`STATUS_LABELS` map (ties into `M-4`). Then render both groups through one mapped loop, and
compute the `entries.some(...)` divider predicates once into named booleans
(`hasAppointments`, `hasWalkIns`) instead of re-scanning the array twice inline.

---

### D-8 — `DisplayMessageMenu` and `DeviceAccessMenu` are the same component (Medium)

**Location:** `src/client/App.tsx` — both render the identical
`hamburger-button` → `menu-backdrop` (with the same `onMouseDown` target-comparison dismissal)
→ `side-menu` → `side-menu-header` → close `icon-button` shell, differing only in the trigger
label/class, the presence of an `<h2>`, and the panel rendered inside.

**Fix:** Extract one `<SideMenu label={...} triggerClassName={...} title={...}>{children}</SideMenu>`
component and render `<SideMenu label="Message"><DisplayMessagePanel …/></SideMenu>` and
`<SideMenu label="☰ Device access"><DeviceAccessPanel /></SideMenu>`. This also gives one place
to add the focus trap and Escape handling from `A-1`.

---

## 6. Performance and cost

### P-1 — 1 s heartbeat with a 500 ms timeout defeats DO hibernation (High)

**Location:** `src/client/App.tsx`, the WebSocket effect — `heartbeat = window.setInterval(beat, 1000)`
and `timeout = window.setTimeout(() => { if (awaiting === id) disconnect(); }, 500)`.

**Problem:** Two compounding issues:

1. **Cost.** Every connected client pings once per second, and `webSocketMessage` responds from
   the DO. The architecture doc specifically chose the Hibernation API so the object can
   evict from memory while sockets stay open — a 1 Hz application-level ping makes hibernation
   impossible, so the DO bills wall-clock duration continuously, 24/7, for as long as a TV is
   on the wall. With four interfaces open that is ~345,000 pings/day.
2. **False positives.** A 500 ms round-trip deadline is shorter than normal latency on a
   congested venue Wi-Fi or a backgrounded mobile tab. `disconnect()` then fires, the
   "Connection lost. Reconnecting…" banner and the full-screen `.disconnect-overlay` appear, and
   the page is disabled — for a transient 600 ms blip. The reconnect then races back
   immediately (`reconnectImmediately = true` on every successful open), so a marginal link
   produces visible banner flapping.

**Fix:** Delete the application-level heartbeat and rely on the platform. Cloudflare's
hibernation-aware WebSockets handle liveness; use the browser's `close`/`error` events plus
`navigator.onLine` for disconnect detection. If an application ping is genuinely required (e.g.
to detect a silently dead intermediary), use a **30-second** interval with a **10-second**
timeout, and set `webSocketAutoResponse` on the DO so pings are answered without waking the
object:

```js
ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair(
    JSON.stringify({ action: 'ping' }),
    JSON.stringify({ type: 'pong' }),
  ),
);
```

Note the auto-response pair requires a _constant_ payload, so drop the incrementing
`heartbeatId`/`awaiting` correlation (which exists only to match the 500 ms deadline). Also add
exponential backoff with jitter to the reconnect (`500 ms → 1 s → 2 s → 4 s`, capped at 30 s)
instead of the current flat `0 ms`/`500 ms`, so a DO restart doesn't get hammered by every
reconnecting client simultaneously.

---

### P-2 — Device authentication writes to SQLite on every request (Medium)

**Location:** `src/room.js`, `checkDevice` —
`UPDATE device_credentials SET last_used_at=? WHERE credential_hash=?`; called from
`src/worker.js`, `devicePermission`, which runs on **every** device-authenticated request
(every `/api/queue` GET, every `/ws` upgrade, every `/api/display-message` GET).

**Problem:** A write transaction per read request, purely to maintain a cosmetic `lastUsedAt`
field shown in the admin device list. Each device request also costs a full Worker→DO subrequest
(`fetch` to `https://queue.internal/api/device/check`) _before_ the actual request is forwarded
to the same DO — so every device API call makes two DO round-trips.

**Fix:** Two independent improvements:

1. Throttle the write — only update `last_used_at` if the stored value is older than ~5 minutes:
   `UPDATE ... WHERE credential_hash=? AND (last_used_at IS NULL OR last_used_at < ?)`.
2. Eliminate the double round-trip — since the Worker is already forwarding to the same DO, pass
   the credential through via the existing `X-Device-Credential` header and have the DO validate
   it inline as part of handling the request, rather than pre-flighting a separate `check` call.
   Keep the standalone `/api/device/check` endpoint only for `/api/pair/session`, which has no
   follow-on request.

---

### P-3 — `mutations` and `pairing_requests` grow without bound (Medium)

**Location:** `src/room.js` — `INSERT INTO mutations (mutation_id,response,created_at)` on every
mutation; `pairing_requests` rows are only ever `UPDATE`d (to `expired`/`denied`/`exchanged`),
never deleted.

**Problem:** The `mutations` dedupe table accumulates one row (including the full JSON response
body) for every check-in, status change, edit, delete, and clear — forever. Likewise every
pairing attempt leaves a permanent row. There is no `alarm()` handler and no cleanup anywhere in
the codebase. Over a year of daily operation this is the DO's dominant storage consumer and
slows the `SELECT response FROM mutations WHERE mutation_id=?` lookup that gates every mutation.
Given the requirements doc's explicit "no queue history is retained" stance, retaining mutation
response bodies indefinitely is also arguably a data-retention violation.

**Fix:** Implement an `alarm()` handler scheduled daily:

```js
async alarm() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  this.sql.exec('DELETE FROM mutations WHERE created_at < ?', cutoff);
  this.sql.exec("DELETE FROM pairing_requests WHERE status != 'pending' AND created_at < ?", cutoff);
  this.sql.exec("UPDATE pairing_requests SET status='expired', credential=NULL WHERE status='pending' AND expires_at <= ?", new Date().toISOString());
  await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
}
```

Schedule the first alarm in `#migrate()` if none is set. A 24-hour dedupe window comfortably
exceeds any realistic client retry. This also subsumes the ad-hoc expiry `UPDATE` currently
embedded in `pendingPairings()`, which only runs when an admin happens to open the panel.

---

### P-4 — `/api/pair/status` is an unauthenticated polling endpoint (Low)

**Location:** `src/worker.js` — `/api/pair` / `/api/pair/status` / `/api/pair/complete` are
grouped under a single unauthenticated passthrough.

**Problem:** Necessarily public (a device has no credential yet), but each `/api/pair/status`
call wakes the DO, computes a SHA-256, and runs a query. Unpaired TVs poll every 5 s
indefinitely, and the advertised `interval` is purely advisory — a client may poll as fast as it
likes. See also `S-5`.

**Fix:** Enforce the interval server-side (`last_polled_at` + `429`), stop polling client-side
after the 10-minute TTL elapses rather than looping forever (`while (!cancelled)` currently never
checks expiry), and consider a Cloudflare Rate Limiting rule on `/api/pair*`.

---

## 7. Accessibility and UX

### A-1 — Modals and side menus have no focus management or Escape handling (Medium)

**Location:** `src/client/App.tsx` — `EditModal` (`role="dialog" aria-modal="true"`),
`DisplayMessageMenu`, `DeviceAccessMenu`.

**Problem:** `EditModal` is correctly labelled but never moves focus into the dialog, never traps
Tab within it, never restores focus to the trigger on close, and cannot be dismissed with
Escape. The two side menus are worse: the `.menu-backdrop` is a plain `<div>` with an
`onMouseDown` handler (not keyboard-reachable, no `role`), and the `<aside>` has no `role="dialog"`,
no `aria-modal`, and no label — `DeviceAccessMenu`'s header contains only a bare close button
with no heading at all. The `.disconnect-overlay` (`z-index: 9999; cursor: not-allowed`) visually
blocks the page but does not actually prevent keyboard interaction with the controls beneath it,
so the requirement "the entire page is disabled / controls cannot be used" is only cosmetically met.

**Fix:** Extract one `<Modal>` primitive (shared by `EditModal` and the `SideMenu` from `D-8`)
that: focuses the first focusable child on mount, traps Tab, restores focus on unmount, closes on
Escape, and renders the backdrop with `aria-hidden`. For the disconnect state, set `inert` on the
main content (or `aria-hidden` plus `disabled` on all controls) rather than relying on an overlay
`<div>`.

### A-2 — `DeviceCodeInput` manipulates focus via global `document.getElementById` (Low)

**Location:** `src/client/App.tsx`, `DeviceCodeInput` — `document.getElementById(\`device-code-${index + 1}\`)?.focus()`in`update`, `handleKey`, and `handlePaste`.

**Problem:** Eight global DOM IDs (`device-code-0` … `device-code-7`) would collide if two
instances ever mounted, and direct `getElementById` from React bypasses the component tree.

**Fix:** Use a `useRef<(HTMLInputElement | null)[]>([])` array and `refs.current[i]?.focus()`.
Also derive the input count from `USER_CODE_LENGTH` (`M-8`) rather than the hard-coded `8` and
`index < 7` / `Math.min(pasted.length, 7)` literals.

### A-3 — TV pairing contradicts the documented public read-only TV (Medium)

**Location:** `docs/WAITING-ROOM-REQUIREMENTS.md` ("The TV route is public and must remain
read-only… `/tv/<display-code>` — public TV display") vs. `src/client/App.tsx`, which puts `tv`
through the full device-pairing flow.

**Problem:** The implementation requires staff to approve an 8-character code before a TV shows
anything, which is a _better_ security posture than the documented short-URL approach — but the
requirements doc was never updated, so the spec and the code disagree about the single most
visible interface. A future contributor reading the doc would "fix" the code back to a public route.

**Fix:** Update `docs/WAITING-ROOM-REQUIREMENTS.md` to describe the implemented device-pairing
model (device code → staff approval → long-lived `HttpOnly` credential cookie → revocable from
the admin panel) and remove the `/tv/<display-code>` suggestion. Note that pairing is strictly
stronger than the original requirement, and that `tv` credentials are read-only.

### A-4 — `/host` is accepted by the client but unknown to the Worker (Low)

**Location:** `src/client/App.tsx` mode detection maps both `/tablet` and `/host` to `'tablet'`;
`src/worker.js`, `requestedPermission()` matches only `path.startsWith('/tablet')` and `/tv`.

**Problem:** `/host` works only because the client appends `?device=tablet` to its API calls,
which `requestedPermission` picks up from the query string. The route is thus load-bearing on a
subtle fallback. The requirements doc names `/host` as the canonical tablet route, while the code
has drifted to `/tablet`.

**Fix:** Pick one canonical path. Recommend keeping `/tablet` and adding `/host` to
`requestedPermission`'s prefix check for backwards compatibility, or dropping `/host` from the
client and the doc entirely. Define the mode table once (`M-2`, `modes.ts`) and derive both the
client routing and the Worker's prefix list from shared constants.

### A-5 — Nested ternaries for mode and status strings (Low)

**Location:** `src/client/App.tsx` — the 5-branch mode ternary, the 4-branch
`document.title` ternary, and the 5-branch pairing-message ternary.

**Fix:** Replace with lookup objects (`MODE_TITLES`, `PAIRING_MESSAGES`) keyed by a proper union
type. See `B-8` and `M-2`.

---

## 8. Tooling and process

### T-1 — All dependencies are pinned to `"latest"` (High)

**Location:** `package.json` — all nine dependencies and devDependencies.

**Problem:** Builds are not reproducible, and `npm ci` in CI resolves from the committed
`package-lock.json` while any local `npm install` silently drifts. The currently-resolved set
includes **TypeScript 7.0.2**, **Vite 8.3.6**, and **React 19.3.1** — major versions that will
keep advancing underneath the project. A breaking change in any of them turns a routine
deploy-on-push into a production outage with no code change to blame. `wrangler` is also
`"latest"` while the CI workflow separately pins `wranglerVersion: "4"`, so the `npx wrangler
secret put` steps and the deploy step can run different major versions.

**Fix:** Pin to caret ranges matching what is installed and verified:

```jsonc
"dependencies": {
  "react": "^19.3.1",
  "react-dom": "^19.3.1"
},
"devDependencies": {
  "@cloudflare/workers-types": "^5.20261108.1",
  "@types/react": "^19.3.0",
  "@types/react-dom": "^19.3.0",
  "@vitejs/plugin-react": "^6.2.1",
  "typescript": "^7.0.2",
  "vite": "^8.3.6",
  "wrangler": "^4.158.0"
}
```

Move `@vitejs/plugin-react` from `dependencies` to `devDependencies` (it is a build-time plugin
and is currently misclassified). Add an `engines.node` field matching CI's Node 22, commit the
lockfile, and configure Dependabot or Renovate for controlled updates.

### T-2 — CI does not typecheck, lint, or test before deploying (High)

**Location:** `.github/workflows/deploy.yml`.

**Problem:** The workflow runs `npm ci` → `npm run build` → secret sync → deploy. The
`typecheck` script exists in `package.json` but is never run in CI, so a type error that Vite's
esbuild transpile ignores (esbuild strips types without checking them) deploys straight to
production. There is no lint step, no test step, and no preview/staging environment — every push
to `main` goes live.

**Fix:** Add `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test` as
required steps before `build`. Run them as a separate `verify` job that `deploy` declares via
`needs: verify`, and run `verify` on pull requests too (`on: pull_request`), so problems surface
before merge rather than during deploy.

### T-3 — No linter and lenient TypeScript settings (High)

**Location:** No ESLint config exists; `tsconfig.json`.

**Problem:** No ESLint means no `react-hooks/exhaustive-deps`, which would have flagged the
genuinely incorrect dependency arrays in `App.tsx`: the pairing effect omits nothing but the
WebSocket effect closes over `refresh` and `loadDisplayMessage` while declaring only
`[mode, deviceReady]`; `DisplayMessagePanel`'s load effect omits `onActiveChange`; and
`DeviceAccessPanel`'s auto-approve effect declares `[code]` while reading `working` and `decide`.
No `no-unused-vars` means `B-6`'s dead `isHumanRoute`, `M-9`'s dead `QueueDraft`, and `B-5`'s
dead props all survive. `tsconfig.json` omits `noUnusedLocals`, `noUnusedParameters`, and
`noUncheckedIndexedAccess`, and `include` covers only `src/client` — leaving all three server
files completely unchecked.

**Fix:** Add `eslint` with `typescript-eslint`, `eslint-plugin-react-hooks`, and
`eslint-plugin-jsx-a11y` (the last would catch `A-1`). Enable `noUnusedLocals`,
`noUnusedParameters`, and `noUncheckedIndexedAccess` in `tsconfig.json`. Fix the flagged
dependency arrays — wrap `refresh` and `loadDisplayMessage` in `useCallback` (or move them into
the hooks from `M-2`, where the problem disappears structurally).

### T-4 — No tests at all (High)

**Problem:** Zero test files; no test runner in `package.json`. The riskiest logic in the
codebase is exactly the logic that is cheapest to test in isolation: the Worker's authorization
matrix (`D-1`), JWT validation and its ten failure modes (`access.js`), mutation idempotency,
queue ordering, and the pairing state machine.

**Fix:** Add `vitest` plus `@cloudflare/vitest-pool-workers` (which runs tests inside workerd
with real Durable Object and SQLite bindings). Minimum viable suite:

- `access.test.js` — one case per `failure` value; expired, wrong audience, wrong issuer, unknown
  `kid`, bad signature, missing email, plus the key-rotation retry from `S-3`.
- `worker.auth.test.js` — a table-driven matrix of (path × method × caller) → expected status,
  asserting every cell. This is the regression net for `S-1` and `D-1`.
- `room.queue.test.js` — insert/patch/delete, ordering (appointments before walk-ins, by
  appointment then check-in then id), and replaying a duplicate `X-Mutation-Id`.
- `room.pairing.test.js` — full pair → approve → complete → check → revoke lifecycle, plus
  expiry; would have caught `B-1`.

### T-5 — Deploy workflow rewrites Cloudflare secrets on every push (Medium)

**Location:** `.github/workflows/deploy.yml`, "Sync Access configuration secrets".

**Problem:** Four `npx wrangler secret put` calls run on every deploy, piping GitHub secrets
into the Worker. If any of `CLOUDFLARE_ACCESS_ADMIN_EMAIL`, `CLOUDFLARE_ACCESS_AUDIENCE`,
`CLOUDFLARE_ACCESS_INTAKE_EMAIL`, or `CLOUDFLARE_ACCESS_TEAM_DOMAIN` is unset in the repository,
`printf '%s' ""` writes an **empty string** over the live secret, silently breaking all staff
authentication (`validate` returns `missing-assertion-or-config`) on an unrelated push. The step
has no `if` guard and no verification. It also runs _before_ the deploy step, uses unpinned
`npx wrangler` (vs. `wranglerVersion: "4"` in the deploy action — see `T-1`), and each invocation
is a separate API round-trip on every push regardless of whether anything changed.

**Fix:** Guard the step and fail loudly rather than writing blanks:

```yaml
- name: Sync Access configuration secrets
  if: >-
    secrets.CLOUDFLARE_ACCESS_ADMIN_EMAIL != '' &&
    secrets.CLOUDFLARE_ACCESS_AUDIENCE != '' &&
    secrets.CLOUDFLARE_ACCESS_INTAKE_EMAIL != '' &&
    secrets.CLOUDFLARE_ACCESS_TEAM_DOMAIN != ''
  run: |
    set -euo pipefail
    for pair in "ADMIN_EMAIL:$ACCESS_ADMIN_EMAIL" ...; do
      name="${pair%%:*}"; value="${pair#*:}"
      [ -n "$value" ] || { echo "::error::$name is empty; refusing to overwrite"; exit 1; }
      printf '%s' "$value" | npx --yes wrangler@4 secret put "$name"
    done
```

Better still: move secret management out of the deploy path entirely into a separate
`workflow_dispatch`-only workflow, since these values change approximately never.

### T-6 — No README (Medium)

**Problem:** The repository has `LICENSE` and three docs but no README. A new contributor cannot
determine how to run the app locally, what the four routes are, what environment variables and
secrets are required (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, `ADMIN_EMAIL`, `INTAKE_EMAIL` —
documented nowhere in the repo, only inferrable from `access.js` and the CI workflow), or how to
pair a device for the first time.

**Fix:** Add a README covering: purpose and a one-paragraph architecture summary; prerequisites;
`npm install` / `npm run dev` / `npx wrangler dev` (note that `npm run dev` serves only the Vite
frontend with no Worker API — a local dev-auth bypass is called for by the requirements doc and
does not exist); the route table; a full environment-variable table; first-run device pairing
instructions; and the deployment flow with a pointer to `docs/DEPLOYMENT-SETUP.md`.

### T-7 — Docs filename typo and stale content (Low)

**Location:** `docs/ACRCHITECTURE-OVERVIEW.md`.

**Problem:** "ACRCHITECTURE" is misspelled. The file also still describes a generic `Room` class
with an `items` table rather than this project's `WaitingRoom`/`queue_entries`, so it reads as an
untailored template — and its `extends DurableObject` example contradicts the actual
implementation (`M-5`).

**Fix:** `git mv docs/ACRCHITECTURE-OVERVIEW.md docs/ARCHITECTURE-OVERVIEW.md` and rewrite the
examples against the real schema and class names. Also reconcile `docs/WAITING-ROOM-REQUIREMENTS.md`
with the implemented TV pairing model (`A-3`), the `/host` vs `/tablet` route (`A-4`), and the
intake delete capability (`B-5`).

---

## 9. What is already good

Worth preserving through any refactor:

- **Mutation idempotency.** The `X-Mutation-Id` + `mutations` table design correctly makes retries
  safe and is exactly what the requirements doc asks for.
- **Credential hygiene.** Device credentials are stored only as SHA-256 hashes in
  `device_credentials`, compared by hash lookup, and delivered in an `HttpOnly; Secure;
SameSite=Strict` cookie. The `tv`/`tablet` permission split is the right model.
- **Live revocation.** `revokeConnections` walking `ctx.getWebSockets()` and matching the
  serialized attachment's `credentialHash` to force-close with code `4001` is a genuinely nice
  touch that many implementations miss.
- **Schema constraints.** `CHECK` constraints on `status` and `permission`, `UNIQUE` on all
  hash columns, and the `CHECK (id = 1)` singleton guard on `display_message` push invariants
  into the database.
- **Ambiguity-free user codes.** `randomUserCode`'s alphabet excludes `I`, `O`, `0`, and `1` —
  correct for a code read aloud off a TV across a room.
- **Server-authoritative ordering.** `listEntries`'s `ORDER BY` encodes the documented ordering
  rules in SQL rather than re-deriving them per client.
- **Full JWT verification.** `access.js` validates algorithm, issuer, audience, expiry, `nbf`
  with clock skew, and the RSA signature against JWKS — it does not merely decode the payload,
  which is the common shortcut.

---

## 10. Suggested commit sequence

| #   | Commit                                                                     | Findings                   |
| --- | -------------------------------------------------------------------------- | -------------------------- |
| 1   | Add Prettier/EditorConfig; format entire tree (no behavior change)         | `M-1`                      |
| 2   | Add ESLint + stricter tsconfig; fix unused vars and hook deps              | `T-3`, `B-6`, `M-9`        |
| 3   | Pin dependency versions; add `engines`; move `@vitejs/plugin-react` to dev | `T-1`                      |
| 4   | Add Vitest + workers pool; author the auth-matrix and queue tests          | `T-4`                      |
| 5   | Wire `/api/pair/deny`; use `RETURNING` for insert id                       | `B-1`, `B-2`               |
| 6   | Fix optimistic-update staleness and the revoked-device screen              | `B-3`, `B-8`               |
| 7   | Guard WebSocket JSON parse; add React error boundary                       | `B-4`                      |
| 8   | Implement intake delete; remove dead `onStatus` prop                       | `B-5`                      |
| 9   | Remove the auth-debug header; gate client logging to dev                   | `S-2`, `S-6`, `S-7`        |
| 10  | Add JWKS TTL and failure eviction with rotation retry                      | `S-3`                      |
| 11  | Scope tablet credentials to status transitions only                        | `S-1`                      |
| 12  | Mint pairing credentials at exchange time                                  | `S-4`                      |
| 13  | Extract `src/shared/` constants and types                                  | `M-3`, `M-4`, `M-8`, `D-4` |
| 14  | Replace the Worker `if`-ladder with a route/auth table                     | `D-1`, `M-6`, `M-7`        |
| 15  | Extract DO body-parsing, error, and hex helpers; extend `DurableObject`    | `D-2`, `D-3`, `M-5`, `B-7` |
| 16  | Split `App.tsx` into hooks and components                                  | `M-2`, `D-5`–`D-8`         |
| 17  | Drop the 1 s heartbeat; add auto-response and backoff                      | `P-1`                      |
| 18  | Throttle `last_used_at`; collapse the double DO round-trip                 | `P-2`                      |
| 19  | Add `alarm()`-based cleanup for mutations and pairings                     | `P-3`, `S-5`, `P-4`        |
| 20  | Add shared `Modal` with focus trap and Escape; fix `inert` on disconnect   | `A-1`, `A-2`, `A-5`        |
| 21  | Harden the deploy workflow; add a `verify` job                             | `T-2`, `T-5`               |
| 22  | Add README; fix docs filename and reconcile with implementation            | `T-6`, `T-7`, `A-3`, `A-4` |
