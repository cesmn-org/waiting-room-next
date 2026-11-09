import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import type { QueueEntry, QueueStatus } from './types';
import { loadQueue, mutateQueue } from './api';

type PairingRequest = {
  id: string;
  permission: 'tv' | 'tablet';
  status: 'pending' | 'approved';
  createdAt: string;
  expiresAt: string;
};
type DeviceCredential = {
  id: string;
  permission: 'tv' | 'tablet';
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
type DisplayMessage = { message: string; active: number; updatedAt: string | null };

declare const __COMMIT_HASH__: string;

const appointmentTimes = Array.from({ length: 58 }, (_, index) => {
  const totalMinutes = 13 * 60 + index * 5;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const label = new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
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
function displayName(entry: QueueEntry) {
  return `${entry.firstName} ${entry.lastName.charAt(0)}.`;
}
function formatDateTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const datePart = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
  const timePart = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  return `${datePart} · ${timePart}`;
}
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <p className="clock">{formatDateTime(now)}</p>;
}
function QueueList({
  title,
  count,
  entries,
  action,
  details = false,
}: {
  title: ReactNode;
  count?: number;
  entries: QueueEntry[];
  action?: (entry: QueueEntry) => ReactNode;
  details?: boolean;
}) {
  return (
    <section className="queue-section">
      <h2 className="queue-heading">
        <span>{title}</span>
        {count !== undefined && <span className="queue-count">{count}</span>}
      </h2>
      {entries.length === 0 ? (
        <p className="empty">No clients</p>
      ) : (
        <div className="name-list">
          {entries.map((entry) => (
            <div className="client-card" key={entry.id}>
              <div>
                <span className="name-text">{displayName(entry)}</span>
                {details && (
                  <div className="entry-details">
                    {entry.appointmentTime
                      ? `Appointment ${formatAppointmentTime(entry.appointmentTime)} · `
                      : ''}
                    Checked in {formatCheckInTime(entry.checkInTime)}
                  </div>
                )}
              </div>
              {action?.(entry)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
function BuildVersion() {
  return <small className="build-version">Build {__COMMIT_HASH__}</small>;
}

function Connection({ connected }: { connected: boolean }) {
  return connected ? null : (
    <>
      <div className="banner">Connection lost. Reconnecting…</div>
      <div className="disconnect-overlay" />
    </>
  );
}
function logNetwork(label: string, details?: unknown) {
  console.info(`[waiting-room] ${label}`, details ?? '');
}

export function App() {
  const mode: 'intake' | 'admin' | 'tablet' | 'tv' = window.location.pathname.startsWith('/intake')
    ? 'intake'
    : window.location.pathname.startsWith('/admin')
      ? 'admin'
      : window.location.pathname.startsWith('/tablet')
        ? 'tablet'
        : window.location.pathname.startsWith('/host')
          ? 'tablet'
          : 'tv';
  useEffect(() => {
    document.title = `Waiting Room: ${mode === 'intake' ? 'Intake' : mode === 'admin' ? 'Admin' : mode === 'tablet' ? 'Tablet' : 'TV'}`;
  }, [mode]);
  const [deviceReady, setDeviceReady] = useState(mode !== 'tv' && mode !== 'tablet');
  const [pairingCode, setPairingCode] = useState('');
  const [pairingStatus, setPairingStatus] = useState('starting');
  const [pairingAttempt, setPairingAttempt] = useState(0);
  const [displayMessage, setDisplayMessage] = useState<DisplayMessage>({
    message: '',
    active: 0,
    updatedAt: null,
  });
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [sessionChecked, setSessionChecked] = useState(mode !== 'intake' && mode !== 'admin');
  const [showAllTablet, setShowAllTablet] = useState(
    () => localStorage.getItem('tablet-show-all') === 'true',
  );
  const appointments = useMemo(
    () =>
      entries.filter(
        (e) =>
          e.appointmentTime && (e.status === 'checked_in' || (mode === 'tablet' && showAllTablet)),
      ),
    [entries, mode, showAllTablet],
  );
  const walkIns = useMemo(
    () =>
      entries.filter(
        (e) =>
          !e.appointmentTime && (e.status === 'checked_in' || (mode === 'tablet' && showAllTablet)),
      ),
    [entries, mode, showAllTablet],
  );
  const checkedInAppointmentCount = useMemo(
    () => entries.filter((entry) => entry.status === 'checked_in' && entry.appointmentTime).length,
    [entries],
  );
  const checkedInWalkInCount = useMemo(
    () => entries.filter((entry) => entry.status === 'checked_in' && !entry.appointmentTime).length,
    [entries],
  );
  const loadDisplayMessage = () =>
    fetch(`/api/display-message${mode === 'tv' ? '?device=tv' : ''}`)
      .then((response) => response.json())
      .then(setDisplayMessage)
      .catch(() => undefined);
  const refresh = () => {
    logNetwork('queue request started');
    return loadQueue(mode === 'tv' || mode === 'tablet' ? mode : undefined)
      .then((loaded) => {
        logNetwork('queue response', { count: loaded.length });
        setEntries(loaded);
      })
      .catch((requestError) => {
        console.error('[waiting-room] queue request failed', requestError);
        setError('Unable to load the queue.');
      });
  };
  useEffect(() => {
    if (mode === 'tv' || mode === 'tablet') {
      let cancelled = false;
      let restartTimer: number | undefined;
      setDeviceReady(false);
      setPairingCode('');
      setPairingStatus('starting');
      const restartPairing = () => {
        restartTimer = window.setTimeout(() => {
          if (!cancelled) {
            setError('');
            setPairingAttempt((attempt) => attempt + 1);
          }
        }, 1500);
      };
      const startPairing = async () => {
        try {
          const response = await fetch('/api/pair/session', {
            credentials: 'same-origin',
            headers: { 'X-Device-Permission': mode },
          });
          if (response.ok) {
            const session = (await response.json()) as { role?: string };
            if (session.role === mode) {
              setDeviceReady(true);
              setPairingStatus('approved');
              return;
            }
          }
        } catch (sessionError) {
          logNetwork('device session check unavailable; continuing to pairing', {
            mode,
            error: sessionError,
          });
        }
        const pairResponse = await fetch('/api/pair', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permission: mode }),
        });
        const pair = (await pairResponse.json()) as {
          deviceCode?: string;
          userCode?: string;
          interval?: number;
          error?: string;
        };
        if (!pair.deviceCode || !pair.userCode)
          throw new Error(pair.error || 'Unable to start pairing.');
        setPairingCode(pair.userCode);
        setPairingStatus('pending');
        while (!cancelled) {
          await new Promise((resolve) => window.setTimeout(resolve, (pair.interval || 5) * 1000));
          const status = (await fetch('/api/pair/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceCode: pair.deviceCode }),
          }).then((result) => result.json())) as { status: string };
          if (status.status === 'approved') {
            const complete = await fetch('/api/pair/complete', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceCode: pair.deviceCode }),
            });
            if (!complete.ok) throw new Error('Unable to complete pairing.');
            const verified = await fetch('/api/pair/session', {
              credentials: 'same-origin',
              headers: { 'X-Device-Permission': mode },
            });
            if (!verified.ok)
              throw new Error('Pairing completed, but the device cookie was not accepted.');
            setDeviceReady(true);
            setPairingStatus('approved');
            break;
          }
          if (['denied', 'expired', 'invalid'].includes(status.status)) {
            setPairingStatus(status.status);
            restartPairing();
            break;
          }
        }
      };
      startPairing().catch((pairError) => {
        if (!cancelled) {
          setError(pairError instanceof Error ? pairError.message : 'Unable to pair this device.');
          setPairingStatus('error');
          restartPairing();
        }
      });
      return () => {
        cancelled = true;
        if (restartTimer) window.clearTimeout(restartTimer);
      };
    }
  }, [mode, pairingAttempt]);
  useEffect(() => {
    if (mode === 'intake' || mode === 'admin') {
      logNetwork('session request started', { mode });
      fetch('/api/session')
        .then(async (response) => {
          const body = await response.text();
          logNetwork('session response', { mode, status: response.status, ok: response.ok, body });
          if (!response.ok) throw new Error(`Authentication required (${response.status})`);
          return JSON.parse(body) as { email: string | null; role: string };
        })
        .then((session) => {
          logNetwork('session authenticated', { mode, email: session.email, role: session.role });
          setUserEmail(session.email || '');
          setSessionChecked(true);
        })
        .catch((sessionError) => {
          console.error('[waiting-room] session request failed', sessionError);
          setError('Staff authentication required.');
          setSessionChecked(true);
        });
    }
  }, [mode]);

  useEffect(() => {
    if ((mode === 'tv' || mode === 'tablet') && !deviceReady) return;

    let retry: number | undefined;
    let socket: WebSocket | undefined;
    let stopped = false;
    let reconnectDelay = 500;

    const connect = () => {
      if (stopped) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socketUrl = `${protocol}//${location.host}/ws${mode === 'tv' || mode === 'tablet' ? `?device=${mode}` : ''}`;
      logNetwork('websocket connecting', { mode });
      socket = new WebSocket(socketUrl);
      socket.onopen = () => {
        logNetwork('websocket opened', { mode });
        reconnectDelay = 500;
        setConnected(true);
        refresh();
      };
      socket.onmessage = (event) => {
        let message: { type: string; entries?: QueueEntry[] };
        try {
          message = JSON.parse(event.data);
        } catch {
          logNetwork('websocket message dropped (unparseable)');
          return;
        }
        logNetwork('websocket message', { type: message.type, count: message.entries?.length });
        if (message.type === 'queue.snapshot' && message.entries) {
          setEntries(message.entries);
          loadDisplayMessage();
        } else if (message.type === 'display-message.updated') loadDisplayMessage();
        else if (message.type === 'queue.updated') refresh();
      };
      socket.onclose = async (event) => {
        logNetwork('websocket closed', {
          mode,
          code: event.code,
          reason: event.reason,
          clean: event.wasClean,
        });
        setConnected(false);
        if ((mode === 'tv' || mode === 'tablet') && event.code === 4001) {
          setDeviceReady(false);
          setPairingStatus('starting');
          setPairingAttempt((attempt) => attempt + 1);
          return;
        }
        if ((mode === 'tv' || mode === 'tablet') && !stopped) {
          try {
            const session = await fetch('/api/pair/session', {
              credentials: 'same-origin',
              headers: { 'X-Device-Permission': mode },
            });
            if (!session.ok) {
              setDeviceReady(false);
              setPairingStatus('starting');
              setPairingAttempt((attempt) => attempt + 1);
              return;
            }
          } catch {
            // Keep the current pairing state during a transient network failure.
          }
        }
        if (!stopped) {
          retry = window.setTimeout(connect, reconnectDelay + Math.random() * reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        }
      };
      socket.onerror = () => {
        logNetwork('websocket error', { mode });
      };
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [mode, deviceReady]);

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
  async function remove(entry: QueueEntry) {
    setEntries((current) => current.filter((e) => e.id !== entry.id));
    try {
      await mutateQueue('DELETE', `/api/queue/${entry.id}`);
    } catch {
      refresh();
      setError('Delete failed; the client was restored.');
    }
  }

  async function editEntry(updated: QueueEntry) {
    setEntries((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    try {
      await mutateQueue('PATCH', `/api/queue/${updated.id}`, {
        firstName: updated.firstName,
        lastName: updated.lastName,
        appointmentTime: updated.appointmentTime,
        checkInTime: updated.checkInTime,
        status: updated.status,
      });
    } catch {
      refresh();
      setError('Update failed; the change was reverted.');
    }
  }

  if ((mode === 'intake' || mode === 'admin' || mode === 'tablet') && !sessionChecked)
    return (
      <main className="auth-loading">
        <div>
          <p>Checking staff access…</p>
          <BuildVersion />
        </div>
      </main>
    );
  if (mode === 'tv' && displayMessage.active)
    return (
      <main className="display-app message-screen">
        <header className="app-header">
          <h1 className="header-title">Waiting Room</h1>
          <Clock />
        </header>
        <div className="display-message">{displayMessage.message}</div>
        <BuildVersion />
      </main>
    );
  if ((mode === 'tv' || mode === 'tablet') && !deviceReady)
    return (
      <main className={mode === 'tv' ? 'pairing-page tv-pairing' : 'pairing-page'}>
        <h1>Waiting Room</h1>
        <h2>Pair this {mode}</h2>
        {pairingCode && (
          <div className="pairing-code">
            {pairingCode.replace(/[^A-Z0-9]/gi, '').replace(/(.{4})(?=.)/, '$1 ')}
          </div>
        )}
        <p>
          {pairingStatus === 'pending'
            ? 'Ask an authorized staff member to approve this device.'
            : pairingStatus === 'starting'
              ? 'Generating pairing code…'
              : pairingStatus === 'expired'
                ? 'This pairing code expired. Reload to try again.'
                : pairingStatus === 'denied'
                  ? 'Pairing was denied. Reload to try again.'
                  : error || 'Unable to pair this device.'}
        </p>
        <BuildVersion />
      </main>
    );
  if (mode === 'admin')
    return (
      <main className="intake-page">
        <header className="intake-header">
          <div>
            <h1>Admin</h1>
            {userEmail && <span className="user-email">{userEmail}</span>}
          </div>
          <Connection connected={connected} />
        </header>
        <DeviceAccessMenu />
        <BuildVersion />
      </main>
    );
  if (mode === 'intake')
    return (
      <>
        <Intake
          entries={entries}
          connected={connected}
          onAdded={refresh}
          onEdit={editEntry}
          onDelete={remove}
          onClear={refresh}
          userEmail={userEmail}
          error={error}
        />
        <BuildVersion />
      </>
    );
  return (
    <main className={mode === 'tablet' ? 'dark-app' : 'display-app'}>
      <header className="app-header">
        <h1 className="header-title">Waiting Room</h1>
        <div className="header-right">
          <Clock />
          <Connection connected={connected} />
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {mode === 'tablet' && (
        <div className="tablet-list-toolbar">
          <div className="visibility-control" aria-label="Client visibility">
            <button
              className={!showAllTablet ? 'selected' : ''}
              aria-pressed={!showAllTablet}
              onClick={() => {
                setShowAllTablet(false);
                localStorage.setItem('tablet-show-all', 'false');
              }}
            >
              Checked-in only
            </button>
            <button
              className={showAllTablet ? 'selected' : ''}
              aria-pressed={showAllTablet}
              onClick={() => {
                setShowAllTablet(true);
                localStorage.setItem('tablet-show-all', 'true');
              }}
            >
              Show all
            </button>
          </div>
        </div>
      )}
      <div className="queue-grid">
        <QueueList
          title="Appointments"
          count={checkedInAppointmentCount}
          entries={appointments}
          details={mode === 'tablet'}
          action={
            mode === 'tablet'
              ? (e) => (
                  <button
                    className="shop-btn"
                    onClick={() =>
                      setStatus(e, e.status === 'shopping' ? 'checked_in' : 'shopping')
                    }
                  >
                    {e.status === 'shopping' ? 'Undo' : 'Shop 🛒 →'}
                  </button>
                )
              : undefined
          }
        />
        <QueueList
          title="Walk-ins"
          count={checkedInWalkInCount}
          entries={walkIns}
          details={mode === 'tablet'}
          action={
            mode === 'tablet'
              ? (e) => (
                  <button
                    className="shop-btn"
                    onClick={() =>
                      setStatus(e, e.status === 'shopping' ? 'checked_in' : 'shopping')
                    }
                  >
                    {e.status === 'shopping' ? 'Undo' : 'Shop 🛒 →'}
                  </button>
                )
              : undefined
          }
        />
      </div>
      <BuildVersion />
    </main>
  );
}

function DisplayMessageMenu() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  return (
    <>
      <button
        className={`hamburger-button ${active ? 'message-active' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Message
      </button>
      {open && (
        <div
          className="menu-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <aside className="side-menu">
            <div className="side-menu-header">
              <h2>Display message</h2>
              <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <DisplayMessagePanel onActiveChange={setActive} />
          </aside>
        </div>
      )}
    </>
  );
}
function DisplayMessagePanel({ onActiveChange }: { onActiveChange: (active: boolean) => void }) {
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/display-message')
      .then(async (response) => {
        const body = await response.text();
        if (!response.ok)
          throw new Error(`Unable to load display message (${response.status}): ${body}`);
        return JSON.parse(body) as DisplayMessage;
      })
      .then((value) => {
        setMessage(value.message);
        setDraft(value.message);
        setActive(Boolean(value.active));
        onActiveChange(Boolean(value.active));
      })
      .catch((loadError) => {
        console.error('[waiting-room] display message load failed', loadError);
        setError(
          loadError instanceof Error ? loadError.message : 'Unable to load display message.',
        );
      });
  }, []);
  async function save() {
    const response = await fetch('/api/display-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: draft, active }),
    });
    if (!response.ok) {
      setError('Unable to save display message.');
      return;
    }
    const value = (await response.json()) as DisplayMessage;
    setMessage(value.message);
    setDraft(value.message);
    setActive(Boolean(value.active));
    onActiveChange(Boolean(value.active));
    setEditing(false);
    setError('');
  }
  async function toggle() {
    const response = await fetch('/api/display-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, active: !active }),
    });
    if (!response.ok) {
      setError('Unable to update display message.');
      return;
    }
    const value = (await response.json()) as DisplayMessage;
    setMessage(value.message);
    setDraft(value.message);
    setActive(Boolean(value.active));
    onActiveChange(Boolean(value.active));
    setError('');
  }
  return (
    <section className="device-panel">
      {editing ? (
        <>
          <p className="panel-help">Edit the message, then save or cancel.</p>
          <textarea
            value={draft}
            maxLength={500}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="message-actions">
            <button onClick={save}>Save</button>
            <button
              className="secondary-button"
              onClick={() => {
                setDraft(message);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="display-message-preview">{message || 'No message entered.'}</p>
          <div className="message-actions">
            <button onClick={() => setEditing(true)}>Edit</button>
            <button className={active ? 'danger-button' : ''} onClick={toggle}>
              {active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
function DeviceAccessMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="hamburger-button"
        aria-label="Open device access menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>☰</span> Device access
      </button>
      {open && (
        <div
          className="menu-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <aside className="side-menu">
            <div className="side-menu-header">
              <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <DeviceAccessPanel />
          </aside>
        </div>
      )}
    </>
  );
}

function DeviceCodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [characters, setCharacters] = useState(() =>
    value
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 8)
      .split(''),
  );
  useEffect(() => {
    setCharacters(
      value
        .replace(/[^A-Z0-9]/gi, '')
        .slice(0, 8)
        .split(''),
    );
  }, [value]);
  function update(index: number, raw: string) {
    const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const next = [...characters];
    next[index] = clean.slice(-1);
    setCharacters(next);
    onChange(next.join(''));
    if (clean && index < 7) document.getElementById(`device-code-${index + 1}`)?.focus();
  }
  function handleKey(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !characters[index] && index > 0)
      document.getElementById(`device-code-${index - 1}`)?.focus();
  }
  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const pasted = event.clipboardData
      .getData('text')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8)
      .split('');
    setCharacters(pasted);
    onChange(pasted.join(''));
    document.getElementById(`device-code-${Math.min(pasted.length, 7)}`)?.focus();
  }
  return (
    <div className="device-code-input" aria-label="Pairing code">
      {Array.from({ length: 8 }, (_, index) => (
        <input
          key={index}
          id={`device-code-${index}`}
          inputMode="text"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={characters[index] || ''}
          onChange={(event) => update(index, event.target.value)}
          onKeyDown={(event) => handleKey(index, event)}
          onPaste={handlePaste}
          disabled={disabled}
          aria-label={`Pairing code character ${index + 1}`}
        />
      ))}
    </div>
  );
}

function DeviceAccessPanel() {
  const [pairings, setPairings] = useState<PairingRequest[]>([]);
  const [devices, setDevices] = useState<DeviceCredential[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  async function load() {
    const [pending, issued] = await Promise.all([
      fetch('/api/pair/pending'),
      fetch('/api/devices'),
    ]);
    if (!pending.ok || !issued.ok) throw new Error('Unable to load device access.');
    setPairings(await pending.json());
    setDevices(await issued.json());
  }
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Unable to load device access.'));
  }, []);
  async function cancelPairing(id: string) {
    setWorking(true);
    setError('');
    try {
      const response = await fetch('/api/pair/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await response.text();
      console.info('[waiting-room] pairing cancel response', {
        status: response.status,
        ok: response.ok,
        body,
      });
      if (!response.ok)
        throw new Error(
          `Unable to cancel pairing request (${response.status}): ${body || 'no response body'}`,
        );
      await load();
    } catch (cancelError) {
      console.error('[waiting-room] pairing cancel failed', cancelError);
      setError(
        cancelError instanceof Error ? cancelError.message : 'Unable to cancel pairing request.',
      );
    } finally {
      setWorking(false);
    }
  }
  async function decide(id: string, userCode: string, action: 'approve' | 'deny') {
    setWorking(true);
    setError('');
    try {
      const response = await fetch(`/api/pair/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, userCode }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || 'Unable to update pairing request.');
      setCodes((current) => ({ ...current, [id]: '' }));
      await load();
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : 'Unable to update pairing request.',
      );
    } finally {
      setWorking(false);
    }
  }
  async function revoke(id: string) {
    setWorking(true);
    setError('');
    try {
      const response = await fetch('/api/devices/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || 'Unable to revoke device credential.');
      await load();
    } catch (revokeError) {
      setError(
        revokeError instanceof Error ? revokeError.message : 'Unable to revoke device credential.',
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="device-panel">
      <h2>Device access</h2>
      <p className="panel-help">Pairing requests and issued device credentials.</p>
      {error && <p className="error">{error}</p>}
      <div className="device-section issued-section">
        {pairings.length || devices.length ? (
          <>
            {pairings.map((pair) =>
              pair.status === 'pending' ? (
                <div className="device-row" key={pair.id}>
                  <span>
                    <strong>{pair.permission} · Pending</strong>
                    <small>Expires {formatDateTime(pair.expiresAt)}</small>
                    <DeviceCodeInput
                      value={codes[pair.id] || ''}
                      onChange={(value) =>
                        setCodes((current) => ({ ...current, [pair.id]: value }))
                      }
                      disabled={working}
                    />
                    <div className="message-actions">
                      <button
                        disabled={working || (codes[pair.id] || '').length !== 8}
                        onClick={() => decide(pair.id, codes[pair.id] || '', 'approve')}
                      >
                        Issue
                      </button>
                      <button
                        className="secondary-button"
                        disabled={working}
                        onClick={() => cancelPairing(pair.id)}
                      >
                        Cancel
                      </button>
                    </div>
                  </span>
                </div>
              ) : (
                <div className="device-row" key={pair.id}>
                  <span>
                    <strong>{pair.permission} · Issued</strong>
                    <small>Issued {formatDateTime(pair.createdAt)}</small>
                  </span>
                </div>
              ),
            )}
            {devices
              .filter((device) => !device.revokedAt)
              .map((device) => (
                <div className="device-row" key={device.id}>
                  <span>
                    <strong>{device.permission} · Issued</strong>
                    <small>Issued {formatDateTime(device.createdAt)}</small>
                  </span>
                  <button
                    className="danger-button"
                    disabled={working}
                    onClick={() => revoke(device.id)}
                  >
                    Revoke
                  </button>
                </div>
              ))}
          </>
        ) : (
          <p className="panel-empty">No device requests.</p>
        )}
      </div>
    </section>
  );
}

function Intake({
  entries,
  onAdded,
  onEdit,
  onDelete,
  onClear,
  userEmail,
  error,
  connected,
}: {
  entries: QueueEntry[];
  connected: boolean;
  onAdded: () => void;
  onDelete: (entry: QueueEntry) => void;
  onEdit: (entry: QueueEntry) => void;
  onClear: () => void;
  userEmail: string;
  error: string;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [appointmentTime, setAppointmentTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [editing, setEditing] = useState<QueueEntry | null>(null);
  const [showAll, setShowAll] = useState(() => localStorage.getItem('intake-show-all') === 'true');
  const checkedInCount = entries.filter((entry) => entry.status === 'checked_in').length;
  const shoppingCount = entries.filter((entry) => entry.status === 'shopping').length;
  const visibleEntries = showAll
    ? entries
    : entries.filter((entry) => entry.status === 'checked_in');

  function changeVisibility(showAllClients: boolean) {
    setShowAll(showAllClients);
    localStorage.setItem('intake-show-all', String(showAllClients));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      await mutateQueue('POST', '/api/queue', {
        firstName,
        lastName,
        appointmentTime: appointmentTime || null,
        checkInTime: localTimeValue(),
      });
      setFirstName('');
      setLastName('');
      setAppointmentTime('');
      onAdded();
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : 'Unable to add client.');
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(updated: QueueEntry) {
    setEditing(null);
    onEdit(updated);
  }
  async function clearAll() {
    if (!window.confirm('Clear all clients from the queue? This cannot be undone.')) return;
    try {
      await mutateQueue('DELETE', '/api/queue');
      onClear();
    } catch (clearError) {
      setFormError(clearError instanceof Error ? clearError.message : 'Unable to clear queue.');
    }
  }

  return (
    <main className="intake-page">
      <header className="intake-header">
        <div>
          <h1>Intake</h1>
          {userEmail && <span className="user-email">{userEmail}</span>}
        </div>
        <div className="intake-menu">
          <button
            className="menu-button clear-button"
            onClick={clearAll}
            disabled={!connected || entries.length === 0}
          >
            Clear All
          </button>
          <DisplayMessageMenu />
          <DeviceAccessMenu />
        </div>
        <Connection connected={connected} />
        {(error || formError) && <p className="error">{formError || error}</p>}
      </header>
      <form className="client-form" onSubmit={submit}>
        <label>
          First name
          <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </label>
        <label>
          Last name
          <input required value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </label>
        <label>
          Appointment time
          <select value={appointmentTime} onChange={(e) => setAppointmentTime(e.target.value)}>
            <option value="">Walk-in</option>
            {appointmentTimes.map((time) => (
              <option key={time.value} value={time.value}>
                {time.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-primary" disabled={!connected || saving}>
          {saving ? 'Adding…' : 'Add client'}
        </button>
      </form>
      <div className="intake-list-toolbar">
        <div>
          <h2>Clients</h2>
          <p className="queue-summary">
            {checkedInCount} checked in
            {shoppingCount > 0 && ` · ${shoppingCount} shopping${showAll ? '' : ' hidden'}`}
          </p>
        </div>
        <div className="visibility-control" aria-label="Client visibility">
          <button
            className={!showAll ? 'selected' : ''}
            aria-pressed={!showAll}
            onClick={() => changeVisibility(false)}
          >
            Checked-in only
          </button>
          <button
            className={showAll ? 'selected' : ''}
            aria-pressed={showAll}
            onClick={() => changeVisibility(true)}
          >
            Show all
          </button>
        </div>
      </div>
      <div className="intake-list">
        <div className="intake-row intake-row-header">
          <span>First name</span>
          <span>Last name</span>
          <span>Appointment Time</span>
          <span>Check-in Time</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        {visibleEntries
          .filter((entry) => entry.appointmentTime)
          .map((entry) => (
            <div className="intake-row" key={entry.id}>
              <span>{entry.firstName}</span>
              <span>{entry.lastName}</span>
              <span>{formatAppointmentTime(entry.appointmentTime!)}</span>
              <span>{formatCheckInTime(entry.checkInTime)}</span>
              <span>
                <span className={`status-badge status-${entry.status}`}>
                  {entry.status === 'checked_in' ? 'Checked in' : 'Shopping'}
                </span>
              </span>
              <div className="row-actions">
                <button disabled={!connected} onClick={() => setEditing(entry)}>
                  Edit
                </button>
              </div>
            </div>
          ))}
        {visibleEntries.some((entry) => entry.appointmentTime) &&
          visibleEntries.some((entry) => !entry.appointmentTime) && (
            <div className="queue-group-divider" />
          )}
        {visibleEntries
          .filter((entry) => !entry.appointmentTime)
          .map((entry) => (
            <div className="intake-row" key={entry.id}>
              <span>{entry.firstName}</span>
              <span>{entry.lastName}</span>
              <span>Walk-in</span>
              <span>{formatCheckInTime(entry.checkInTime)}</span>
              <span>
                <span className={`status-badge status-${entry.status}`}>
                  {entry.status === 'checked_in' ? 'Checked in' : 'Shopping'}
                </span>
              </span>
              <div className="row-actions">
                <button disabled={!connected} onClick={() => setEditing(entry)}>
                  Edit
                </button>
              </div>
            </div>
          ))}
      </div>
      {editing && (
        <EditModal
          entry={editing}
          onCancel={() => setEditing(null)}
          onSave={saveEdit}
          onDelete={() => {
            if (window.confirm('Delete this client from the queue? This cannot be undone.')) {
              onDelete(editing);
              setEditing(null);
            }
          }}
        />
      )}
    </main>
  );
}

function EditModal({
  entry,
  onCancel,
  onSave,
  onDelete,
}: {
  entry: QueueEntry;
  onCancel: () => void;
  onSave: (entry: QueueEntry) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(entry);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <div className="modal-header">
          <h2 id="edit-title">Edit client</h2>
          <button className="icon-button" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <label>
            First name
            <input
              value={draft.firstName}
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
            />
          </label>
          <label>
            Last name
            <input
              value={draft.lastName}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
            />
          </label>
          <label>
            Check-in time
            <input
              type="time"
              value={draft.checkInTime}
              onChange={(e) => setDraft({ ...draft, checkInTime: e.target.value })}
            />
          </label>
          <label>
            Appointment time
            <select
              value={draft.appointmentTime ?? ''}
              onChange={(e) => setDraft({ ...draft, appointmentTime: e.target.value || null })}
            >
              <option value="">Walk-in</option>
              {appointmentTimes.map((time) => (
                <option key={time.value} value={time.value}>
                  {time.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as QueueStatus })}
            >
              <option value="checked_in">Checked in</option>
              <option value="shopping">Shopping</option>
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger-button" onClick={onDelete}>
            Delete
          </button>
          <button onClick={() => onSave(draft)}>Save changes</button>
        </div>
      </div>
    </div>
  );
}
