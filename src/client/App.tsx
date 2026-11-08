import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import type { QueueEntry, QueueStatus } from './types';
import { loadQueue, mutateQueue } from './api';

type PairingRequest = { id: string; permission: 'tv' | 'tablet'; createdAt: string; expiresAt: string };
type DeviceCredential = { id: string; permission: 'tv' | 'tablet'; createdAt: string; revokedAt: string | null; lastUsedAt: string | null };

const appointmentTimes = Array.from({ length: 58 }, (_, index) => {
  const totalMinutes = 13 * 60 + index * 5;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const label = new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { value, label };
});

function localTimeValue(date = new Date()) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(11, 16);
}

function formatCheckInTime(value: string) {
  const time = /^\d{2}:\d{2}$/.test(value) ? value : localTimeValue(new Date(value));
  const [hour, minute] = time.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function formatAppointmentTime(value: string) {
  const normalized = value.trim().slice(0, 5);
  const configured = appointmentTimes.find((time) => time.value === normalized);
  if (configured) return configured.label;
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return value;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}
function displayName(entry: QueueEntry) { return `${entry.firstName} ${entry.lastName.charAt(0)}.`; }
function Clock() { const [now, setNow] = useState(() => new Date()); useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []); return <p className="clock">{new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(now)}</p>; }
function QueueList({ title, entries, action, details = false }: { title: string; entries: QueueEntry[]; action?: (entry: QueueEntry) => ReactNode; details?: boolean }) { return <section className="queue-section"><h2>{title}</h2>{entries.length === 0 ? <p className="empty">No clients</p> : <div className="name-list">{entries.map((entry) => <div className="client-card" key={entry.id}><div><span className="name-text">{displayName(entry)}</span>{details && <div className="entry-details">{entry.appointmentTime ? `Appointment ${formatAppointmentTime(entry.appointmentTime)} · ` : ''}Checked in {formatCheckInTime(entry.checkInTime)}</div>}</div>{action?.(entry)}</div>)}</div>}</section>; }
function Connection({ connected }: { connected: boolean }) { return connected ? null : <><div className="banner">Connection lost. Reconnecting…</div><div className="disconnect-overlay" /></>; }
function logNetwork(label: string, details?: unknown) { console.info(`[waiting-room] ${label}`, details ?? ''); }

export function App() {
  const mode: 'intake' | 'admin' | 'tablet' | 'tv' = window.location.pathname.startsWith('/intake') ? 'intake' : window.location.pathname.startsWith('/admin') ? 'admin' : window.location.pathname.startsWith('/tablet') ? 'tablet' : window.location.pathname.startsWith('/host') ? 'tablet' : 'tv';
  const [deviceReady, setDeviceReady] = useState(mode !== 'tv' && mode !== 'tablet'); const [pairingCode, setPairingCode] = useState(''); const [pairingStatus, setPairingStatus] = useState('starting');
  const [entries, setEntries] = useState<QueueEntry[]>([]); const [connected, setConnected] = useState(false); const [error, setError] = useState(''); const [userEmail, setUserEmail] = useState(''); const [sessionChecked, setSessionChecked] = useState(mode !== 'intake' && mode !== 'admin' && mode !== 'tablet');
  const appointments = useMemo(() => entries.filter((e) => e.status === 'checked_in' && e.appointmentTime), [entries]); const walkIns = useMemo(() => entries.filter((e) => e.status === 'checked_in' && !e.appointmentTime), [entries]); const shopping = useMemo(() => entries.filter((e) => e.status === 'shopping'), [entries]);
  const refresh = () => { logNetwork('queue request started'); return loadQueue().then((loaded) => { logNetwork('queue response', { count: loaded.length }); setEntries(loaded); }).catch((requestError) => { console.error('[waiting-room] queue request failed', requestError); setError('Unable to load the queue.'); }); };
  useEffect(() => { if (mode === 'tv' || mode === 'tablet') { let cancelled = false; setPairingStatus('starting'); fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission: mode }) }).then((response) => response.json()).then(async (pair: { deviceCode?: string; userCode?: string; interval?: number; error?: string }) => { if (!pair.deviceCode || !pair.userCode) throw new Error(pair.error || 'Unable to start pairing.'); setPairingCode(pair.userCode); setPairingStatus('pending'); while (!cancelled) { await new Promise((resolve) => window.setTimeout(resolve, (pair.interval || 5) * 1000)); const status = await fetch('/api/pair/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: pair.deviceCode }) }).then((response) => response.json()) as { status: string }; if (status.status === 'approved') { const complete = await fetch('/api/pair/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: pair.deviceCode }) }); if (!complete.ok) throw new Error('Unable to complete pairing.'); setDeviceReady(true); setPairingStatus('approved'); break; } if (status.status === 'denied' || status.status === 'expired' || status.status === 'invalid') { setPairingStatus(status.status); break; } } }).catch((pairError) => { if (!cancelled) { setError(pairError instanceof Error ? pairError.message : 'Unable to start pairing.'); setPairingStatus('error'); } }); return () => { cancelled = true; }; } }, [mode]);
  useEffect(() => { if (mode === 'intake' || mode === 'tablet' || mode === 'admin') { logNetwork('session request started', { mode }); fetch('/api/session').then(async (response) => { const body = await response.text(); logNetwork('session response', { mode, status: response.status, ok: response.ok, body }); if (!response.ok) throw new Error(`Authentication required (${response.status})`); return JSON.parse(body) as { email: string | null; role: string }; }).then((session) => { logNetwork('session authenticated', { mode, email: session.email, role: session.role }); setUserEmail(session.email || ''); setSessionChecked(true); }).catch((sessionError) => { console.error('[waiting-room] session request failed', sessionError); setError('Staff authentication required.'); setSessionChecked(true); }); } }, [mode]);

  useEffect(() => {
    let retry: number | undefined; let heartbeat: number | undefined; let timeout: number | undefined; let socket: WebSocket; let stopped = false; let reconnectImmediately = true; let heartbeatId = 0; let awaiting: number | undefined;
    const clear = () => { if (heartbeat) clearInterval(heartbeat); if (timeout) clearTimeout(timeout); heartbeat = undefined; timeout = undefined; awaiting = undefined; };
    const disconnect = () => { setConnected(false); clear(); if (socket.readyState === WebSocket.OPEN) socket.close(); };
    const connect = () => { const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const socketUrl = `${protocol}//${location.host}/ws`; logNetwork('websocket connecting', { url: socketUrl, mode }); socket = new WebSocket(socketUrl); socket.onopen = () => { logNetwork('websocket opened', { mode }); setConnected(true); reconnectImmediately = true; refresh(); const beat = () => { if (socket.readyState !== WebSocket.OPEN) return; const id = ++heartbeatId; awaiting = id; socket.send(JSON.stringify({ action: 'ping', id })); if (timeout) clearTimeout(timeout); timeout = window.setTimeout(() => { if (awaiting === id) disconnect(); }, 500); }; beat(); heartbeat = window.setInterval(beat, 1000); }; socket.onmessage = (event) => { const message = JSON.parse(event.data) as { type: string; id?: number; entries?: QueueEntry[] }; logNetwork('websocket message', message); if (message.type === 'pong' && message.id === awaiting) { if (timeout) clearTimeout(timeout); timeout = undefined; awaiting = undefined; } else if (message.type === 'queue.snapshot' && message.entries) setEntries(message.entries); else if (message.type === 'queue.updated') refresh(); }; socket.onclose = (event) => { console.warn('[waiting-room] websocket closed', { mode, code: event.code, reason: event.reason, clean: event.wasClean }); setConnected(false); clear(); if (!stopped) { if (retry) clearTimeout(retry); retry = window.setTimeout(connect, reconnectImmediately ? 0 : 500); reconnectImmediately = false; } }; socket.onerror = (event) => { console.error('[waiting-room] websocket error', { mode, event }); disconnect(); }; };
    if (mode === 'tv' || mode === 'tablet') { if (!deviceReady) return; } connect(); return () => { stopped = true; if (retry) clearTimeout(retry); clear(); socket?.close(); };
  }, [mode, deviceReady]);

  async function setStatus(entry: QueueEntry, status: QueueStatus) { const previous = entries; setEntries(entries.map((e) => e.id === entry.id ? { ...e, status } : e)); try { await mutateQueue('PATCH', `/api/queue/${entry.id}`, { status }); } catch { setEntries(previous); setError('Update failed; the change was reverted.'); } }
  async function remove(entry: QueueEntry) { const previous = entries; setEntries(entries.filter((e) => e.id !== entry.id)); try { await mutateQueue('DELETE', `/api/queue/${entry.id}`); } catch { setEntries(previous); setError('Delete failed; the client was restored.'); } }

  async function editEntry(updated: QueueEntry) { const previous = entries; setEntries(entries.map((entry) => entry.id === updated.id ? updated : entry)); try { await mutateQueue('PATCH', `/api/queue/${updated.id}`, { firstName: updated.firstName, lastName: updated.lastName, appointmentTime: updated.appointmentTime, checkInTime: updated.checkInTime, status: updated.status }); } catch { setEntries(previous); setError('Update failed; the change was reverted.'); } }

  if ((mode === 'intake' || mode === 'admin' || mode === 'tablet') && !sessionChecked) return <main className="auth-loading">Checking staff access…</main>;
  if ((mode === 'tv' || mode === 'tablet') && !deviceReady) return <main className={mode === 'tv' ? 'pairing-page tv-pairing' : 'pairing-page'}><h1>Waiting Room</h1><h2>Pair this {mode}</h2>{pairingCode && <div className="pairing-code">{pairingCode}</div>}<p>{pairingStatus === 'pending' ? 'Ask an authorized staff member to approve this device.' : pairingStatus === 'starting' ? 'Generating pairing code…' : pairingStatus === 'expired' ? 'This pairing code expired. Reload to try again.' : pairingStatus === 'denied' ? 'Pairing was denied. Reload to try again.' : error || 'Unable to pair this device.'}</p></main>;
  if (mode === 'admin') return <main className="intake-page"><header className="intake-header"><div><h1>Admin</h1>{userEmail && <span className="user-email">{userEmail}</span>}</div><Connection connected={connected} /></header><DeviceAccessMenu /></main>;
  if (mode === 'intake') return <Intake entries={entries} connected={connected} onAdded={refresh} onStatus={setStatus} onDelete={remove} onEdit={editEntry} onClear={refresh} userEmail={userEmail} error={error} />;
  return <main className={mode === 'tablet' ? 'dark-app' : 'display-app'}><header className="app-header"><h1 className="header-title">Waiting Room</h1><div className="header-right"><Clock /><Connection connected={connected} /></div></header>{error && <p className="error">{error}</p>}<div className="queue-grid"><QueueList title="Appointments" entries={appointments} details={mode === 'tablet'} action={mode === 'tablet' ? (e) => <button className="shop-btn" onClick={() => setStatus(e, 'shopping')}>Call to shop</button> : undefined} /><QueueList title="Walk-ins" entries={walkIns} details={mode === 'tablet'} action={mode === 'tablet' ? (e) => <button className="shop-btn" onClick={() => setStatus(e, 'shopping')}>Call to shop</button> : undefined} />{mode === 'tablet' && <QueueList title="Shopping / undo" entries={shopping} action={(e) => <button className="shop-btn" onClick={() => setStatus(e, 'checked_in')}>Undo</button>} />}</div></main>;
}

function DeviceAccessMenu() { const [open, setOpen] = useState(false); return <><button className="hamburger-button" aria-label="Open device access menu" aria-expanded={open} onClick={() => setOpen(!open)}><span>☰</span> Device access</button>{open && <div className="menu-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><aside className="side-menu"><div className="side-menu-header"><h2>Device access</h2><button className="icon-button" onClick={() => setOpen(false)} aria-label="Close">×</button></div><DeviceAccessPanel /></aside></div>}</>;
}

function DeviceAccessPanel() {
  const [pairings, setPairings] = useState<PairingRequest[]>([]); const [devices, setDevices] = useState<DeviceCredential[]>([]); const [code, setCode] = useState(''); const [error, setError] = useState(''); const [working, setWorking] = useState(false);
  async function load() { const [pending, issued] = await Promise.all([fetch('/api/pair/pending'), fetch('/api/devices')]); if (!pending.ok || !issued.ok) throw new Error('Unable to load device access.'); setPairings(await pending.json()); setDevices(await issued.json()); }
  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : 'Unable to load device access.')); }, []);
  async function decide(userCode: string, action: 'approve' | 'deny') { setWorking(true); setError(''); try { const response = await fetch(`/api/pair/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userCode }) }); const body = await response.json().catch(() => null); if (!response.ok) throw new Error(body?.error || 'Unable to update pairing request.'); setCode(''); await load(); } catch (decisionError) { setError(decisionError instanceof Error ? decisionError.message : 'Unable to update pairing request.'); } finally { setWorking(false); } }
  async function revoke(id: string) { setWorking(true); setError(''); try { const response = await fetch('/api/devices/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); const body = await response.json().catch(() => null); if (!response.ok) throw new Error(body?.error || 'Unable to revoke device credential.'); await load(); } catch (revokeError) { setError(revokeError instanceof Error ? revokeError.message : 'Unable to revoke device credential.'); } finally { setWorking(false); } }
  return <section className="device-panel"><h2>Device access</h2><p className="panel-help">Enter the code shown on the TV or tablet, then approve or deny it. Pending requests below are informational only.</p><div className="pair-code-form"><input placeholder="Example: ABCD-2345" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /><button disabled={!code || working} onClick={() => decide(code.trim(), 'approve')}>{working ? 'Working…' : 'Approve code'}</button><button className="secondary-button" disabled={!code || working} onClick={() => decide(code.trim(), 'deny')}>Deny code</button></div>{error && <p className="error">{error}</p>}<h3>Pending requests</h3>{pairings.length ? pairings.map((pair) => <div className="device-row" key={pair.id}><span><strong>{pair.permission}</strong><small>Expires {new Date(pair.expiresAt).toLocaleTimeString()} · Use the code shown on the device above</small></span></div>) : <p className="panel-empty">No pending requests.</p>}<h3>Issued credentials</h3>{devices.length ? devices.map((device) => <div className="device-row" key={device.id}><span><strong>{device.permission}</strong><small>{device.revokedAt ? 'Revoked' : 'Active'} · {new Date(device.createdAt).toLocaleString()}</small></span>{!device.revokedAt && <button className="danger-button" onClick={() => revoke(device.id)}>Revoke</button>}</div>) : <p className="panel-empty">No issued credentials.</p>}</section>;
}

function Intake({ entries, onAdded, onEdit, onClear, userEmail, error, connected }: { entries: QueueEntry[]; connected: boolean; onAdded: () => void; onStatus: (entry: QueueEntry, status: QueueStatus) => void; onDelete: (entry: QueueEntry) => void; onEdit: (entry: QueueEntry) => void; onClear: () => void; userEmail: string; error: string }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [appointmentTime, setAppointmentTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [editing, setEditing] = useState<QueueEntry | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      await mutateQueue('POST', '/api/queue', { firstName, lastName, appointmentTime: appointmentTime || null, checkInTime: localTimeValue() });
      setFirstName(''); setLastName(''); setAppointmentTime('');
      onAdded();
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : 'Unable to add client.');
    } finally { setSaving(false); }
  }

  async function saveEdit(updated: QueueEntry) { setEditing(null); onEdit(updated); }
  async function clearAll() { if (!window.confirm('Clear all clients from the queue? This cannot be undone.')) return; try { await mutateQueue('DELETE', '/api/queue'); onClear(); } catch (clearError) { setFormError(clearError instanceof Error ? clearError.message : 'Unable to clear queue.'); } }

  return <main className="intake-page"><header className="intake-header"><div><h1>Intake</h1>{userEmail && <span className="user-email">{userEmail}</span>}</div><div className="intake-menu"><button className="menu-button" onClick={clearAll} disabled={!connected || entries.length === 0}>Clear All</button><DeviceAccessMenu /></div><Connection connected={connected} />{(error || formError) && <p className="error">{formError || error}</p>}</header><form className="client-form" onSubmit={submit}><label>First name<input required value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label><label>Last name<input required value={lastName} onChange={(e) => setLastName(e.target.value)} /></label><label>Appointment time<select value={appointmentTime} onChange={(e) => setAppointmentTime(e.target.value)}><option value="">Walk-in</option>{appointmentTimes.map((time) => <option key={time.value} value={time.value}>{time.label}</option>)}</select></label><button className="btn-primary" disabled={!connected || saving}>{saving ? 'Adding…' : 'Add client'}</button></form><div className="intake-list"><div className="intake-row intake-row-header"><span>First name</span><span>Last name</span><span>Appointment Time</span><span>Check-in Time</span><span>Actions</span></div>{entries.map((entry) => <div className="intake-row" key={entry.id}><span>{entry.firstName}</span><span>{entry.lastName}</span><span>{entry.appointmentTime ? formatAppointmentTime(entry.appointmentTime) : 'Walk-in'}</span><span>{formatCheckInTime(entry.checkInTime)}</span><div className="row-actions"><button disabled={!connected} onClick={() => setEditing(entry)}>Edit</button></div></div>)}</div>{editing && <EditModal entry={editing} onCancel={() => setEditing(null)} onSave={saveEdit} />}</main>;
}

function EditModal({ entry, onCancel, onSave }: { entry: QueueEntry; onCancel: () => void; onSave: (entry: QueueEntry) => void }) {
  const [draft, setDraft] = useState(entry);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title"><div className="modal-header"><h2 id="edit-title">Edit client</h2><button className="icon-button" onClick={onCancel} aria-label="Close">×</button></div><div className="modal-body"><label>First name<input value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} /></label><label>Last name<input value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} /></label><label>Check-in time<input type="time" value={draft.checkInTime} onChange={(e) => setDraft({ ...draft, checkInTime: e.target.value })} /></label><label>Appointment time<select value={draft.appointmentTime ?? ''} onChange={(e) => setDraft({ ...draft, appointmentTime: e.target.value || null })}><option value="">Walk-in</option>{appointmentTimes.map((time) => <option key={time.value} value={time.value}>{time.label}</option>)}</select></label><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as QueueStatus })}><option value="checked_in">Checked in</option><option value="shopping">Shopping</option></select></label></div><div className="modal-actions"><button className="secondary-button" onClick={onCancel}>Cancel</button><button onClick={() => onSave(draft)}>Save changes</button></div></div></div>;
}
