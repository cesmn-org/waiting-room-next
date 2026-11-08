import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import type { QueueEntry, QueueStatus } from './types';
import { loadQueue, mutateQueue } from './api';

const appointmentTimes = Array.from({ length: 58 }, (_, index) => {
  const totalMinutes = 13 * 60 + index * 5;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const label = new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { value, label };
});

function localDateTimeValue(date = new Date()) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function formatAppointmentTime(value: string) { const [hour, minute] = value.split(':').map(Number); return new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function displayName(entry: QueueEntry) { return `${entry.firstName} ${entry.lastName.charAt(0)}.`; }
function Clock() { const [now, setNow] = useState(() => new Date()); useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []); return <p className="clock">{new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(now)}</p>; }
function formatCheckInTime(value: string) { return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
function QueueList({ title, entries, action, details = false }: { title: string; entries: QueueEntry[]; action?: (entry: QueueEntry) => ReactNode; details?: boolean }) { return <section className="queue-section"><h2>{title}</h2>{entries.length === 0 ? <p className="empty">No clients</p> : <div className="name-list">{entries.map((entry) => <div className="client-card" key={entry.id}><div><span className="name-text">{displayName(entry)}</span>{details && <div className="entry-details">{entry.appointmentTime ? `Appointment ${formatAppointmentTime(entry.appointmentTime)} · ` : ''}Checked in {formatCheckInTime(entry.checkInTime)}</div>}</div>{action?.(entry)}</div>)}</div>}</section>; }
function Connection({ connected }: { connected: boolean }) { return connected ? null : <><div className="banner">Connection lost. Reconnecting…</div><div className="disconnect-overlay" /></>; }

export function App() {
  const mode = window.location.pathname.startsWith('/intake') ? 'intake' : window.location.pathname.startsWith('/tablet') ? 'tablet' : window.location.pathname.startsWith('/host') ? 'tablet' : 'tv';
  const [entries, setEntries] = useState<QueueEntry[]>([]); const [connected, setConnected] = useState(false); const [error, setError] = useState('');
  const appointments = useMemo(() => entries.filter((e) => e.status === 'checked_in' && e.appointmentTime), [entries]); const walkIns = useMemo(() => entries.filter((e) => e.status === 'checked_in' && !e.appointmentTime), [entries]); const shopping = useMemo(() => entries.filter((e) => e.status === 'shopping'), [entries]);
  const refresh = () => loadQueue().then(setEntries).catch(() => setError('Unable to load the queue.'));

  useEffect(() => {
    let retry: number | undefined; let heartbeat: number | undefined; let timeout: number | undefined; let socket: WebSocket; let stopped = false; let reconnectImmediately = true; let heartbeatId = 0; let awaiting: number | undefined;
    const clear = () => { if (heartbeat) clearInterval(heartbeat); if (timeout) clearTimeout(timeout); heartbeat = undefined; timeout = undefined; awaiting = undefined; };
    const disconnect = () => { setConnected(false); clear(); if (socket.readyState === WebSocket.OPEN) socket.close(); };
    const connect = () => { const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; socket = new WebSocket(`${protocol}//${location.host}/ws`); socket.onopen = () => { setConnected(true); reconnectImmediately = true; refresh(); const beat = () => { if (socket.readyState !== WebSocket.OPEN) return; const id = ++heartbeatId; awaiting = id; socket.send(JSON.stringify({ action: 'ping', id })); if (timeout) clearTimeout(timeout); timeout = window.setTimeout(() => { if (awaiting === id) disconnect(); }, 500); }; beat(); heartbeat = window.setInterval(beat, 1000); }; socket.onmessage = (event) => { const message = JSON.parse(event.data) as { type: string; id?: number; entries?: QueueEntry[] }; if (message.type === 'pong' && message.id === awaiting) { if (timeout) clearTimeout(timeout); timeout = undefined; awaiting = undefined; } else if (message.type === 'queue.snapshot' && message.entries) setEntries(message.entries); else if (message.type === 'queue.updated') refresh(); }; socket.onclose = () => { setConnected(false); clear(); if (!stopped) { if (retry) clearTimeout(retry); retry = window.setTimeout(connect, reconnectImmediately ? 0 : 500); reconnectImmediately = false; } }; socket.onerror = disconnect; };
    connect(); return () => { stopped = true; if (retry) clearTimeout(retry); clear(); socket?.close(); };
  }, []);

  async function setStatus(entry: QueueEntry, status: QueueStatus) { const previous = entries; setEntries(entries.map((e) => e.id === entry.id ? { ...e, status } : e)); try { await mutateQueue('PATCH', `/api/queue/${entry.id}`, { status }); } catch { setEntries(previous); setError('Update failed; the change was reverted.'); } }
  async function remove(entry: QueueEntry) { const previous = entries; setEntries(entries.filter((e) => e.id !== entry.id)); try { await mutateQueue('DELETE', `/api/queue/${entry.id}`); } catch { setEntries(previous); setError('Delete failed; the client was restored.'); } }

  async function editEntry(updated: QueueEntry) { const previous = entries; setEntries(entries.map((entry) => entry.id === updated.id ? updated : entry)); try { await mutateQueue('PATCH', `/api/queue/${updated.id}`, { firstName: updated.firstName, lastName: updated.lastName, appointmentTime: updated.appointmentTime, checkInTime: updated.checkInTime, status: updated.status }); } catch { setEntries(previous); setError('Update failed; the change was reverted.'); } }

  if (mode === 'intake') return <Intake entries={entries} connected={connected} onAdded={refresh} onStatus={setStatus} onDelete={remove} onEdit={editEntry} error={error} />;
  return <main className={mode === 'tablet' ? 'dark-app' : 'display-app'}><header className="app-header"><h1 className="header-title">Waiting Room</h1><div className="header-right"><Clock /><Connection connected={connected} /></div></header>{error && <p className="error">{error}</p>}<div className="queue-grid"><QueueList title="Appointments" entries={appointments} details={mode === 'tablet'} action={mode === 'tablet' ? (e) => <button className="shop-btn" onClick={() => setStatus(e, 'shopping')}>Call to shop</button> : undefined} /><QueueList title="Walk-ins" entries={walkIns} details={mode === 'tablet'} action={mode === 'tablet' ? (e) => <button className="shop-btn" onClick={() => setStatus(e, 'shopping')}>Call to shop</button> : undefined} />{mode === 'tablet' && <QueueList title="Shopping / undo" entries={shopping} action={(e) => <button className="shop-btn" onClick={() => setStatus(e, 'checked_in')}>Undo</button>} />}</div></main>;
}

function Intake({ entries, connected, onAdded, onStatus, onDelete, onEdit, error }: { entries: QueueEntry[]; connected: boolean; onAdded: () => void; onStatus: (entry: QueueEntry, status: QueueStatus) => void; onDelete: (entry: QueueEntry) => void; onEdit: (entry: QueueEntry) => void; error: string }) {
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
      await mutateQueue('POST', '/api/queue', { firstName, lastName, appointmentTime: appointmentTime || null, checkInTime: new Date(localDateTimeValue()).toISOString() });
      setFirstName(''); setLastName(''); setAppointmentTime('');
      onAdded();
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : 'Unable to add client.');
    } finally { setSaving(false); }
  }

  async function saveEdit(updated: QueueEntry) { setEditing(null); onEdit(updated); }

  return <main className="intake-page"><header className="intake-header"><h1>Intake</h1><Connection connected={connected} />{(error || formError) && <p className="error">{formError || error}</p>}</header><form className="client-form" onSubmit={submit}><label>First name<input required value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label><label>Last name<input required value={lastName} onChange={(e) => setLastName(e.target.value)} /></label><label>Appointment time<select value={appointmentTime} onChange={(e) => setAppointmentTime(e.target.value)}><option value="">Walk-in</option>{appointmentTimes.map((time) => <option key={time.value} value={time.value}>{time.label}</option>)}</select></label><button className="btn-primary" disabled={!connected || saving}>{saving ? 'Adding…' : 'Add client'}</button></form><div className="intake-list"><div className="intake-row intake-row-header"><span>First name</span><span>Last name</span><span>Appointment</span><span>Actions</span></div>{entries.map((entry) => <div className="intake-row" key={entry.id}><span>{entry.firstName}</span><span>{entry.lastName}</span><span>{entry.appointmentTime ? formatAppointmentTime(entry.appointmentTime) : 'Walk-in'}</span><div className="row-actions"><button disabled={!connected} onClick={() => setEditing(entry)}>Edit</button></div></div>)}</div>{editing && <EditModal entry={editing} onCancel={() => setEditing(null)} onSave={saveEdit} />}</main>;
}

function EditModal({ entry, onCancel, onSave }: { entry: QueueEntry; onCancel: () => void; onSave: (entry: QueueEntry) => void }) {
  const [draft, setDraft] = useState(entry);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title"><div className="modal-header"><h2 id="edit-title">Edit client</h2><button className="icon-button" onClick={onCancel} aria-label="Close">×</button></div><div className="modal-body"><label>First name<input value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} /></label><label>Last name<input value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} /></label><label>Appointment time<select value={draft.appointmentTime ?? ''} onChange={(e) => setDraft({ ...draft, appointmentTime: e.target.value || null })}><option value="">Walk-in</option>{appointmentTimes.map((time) => <option key={time.value} value={time.value}>{time.label}</option>)}</select></label><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as QueueStatus })}><option value="checked_in">Checked in</option><option value="shopping">Shopping</option></select></label></div><div className="modal-actions"><button className="secondary-button" onClick={onCancel}>Cancel</button><button onClick={() => onSave(draft)}>Save changes</button></div></div></div>;
}
