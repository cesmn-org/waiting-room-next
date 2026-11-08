import { useEffect, useMemo, useState } from 'react';
import type { QueueEntry } from './types';

function displayName(entry: QueueEntry): string {
  return `${entry.firstName} ${entry.lastName.charAt(0)}.`;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <p className="clock">{new Intl.DateTimeFormat(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).format(now)}</p>;
}

function QueueList({ title, entries }: { title: string; entries: QueueEntry[] }) {
  return (
    <section className="queue-section">
      <h2>{title}</h2>
      {entries.length === 0 ? <p className="empty">No clients waiting</p> : (
        <ol>{entries.map((entry) => <li key={entry.id}>{displayName(entry)}</li>)}</ol>
      )}
    </section>
  );
}

export function App() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const appointments = useMemo(() => entries.filter((entry) => entry.status === 'checked_in' && entry.appointmentTime), [entries]);
  const walkIns = useMemo(() => entries.filter((entry) => entry.status === 'checked_in' && !entry.appointmentTime), [entries]);

  useEffect(() => {
    let retry: number | undefined;
    let socket: WebSocket;
    let stopped = false;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as { type: string; entries?: QueueEntry[] };
        if (message.type === 'queue.snapshot' && message.entries) setEntries(message.entries);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) retry = window.setTimeout(connect, 2000);
      };
      socket.onerror = () => setConnected(false);
    };

    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return (
    <main>
      <header>
        <h1>Waiting Room</h1>
        <Clock />
        <p className={connected ? 'connection live' : 'connection offline'}>
          {connected ? 'Live' : 'Connection lost. Reconnecting…'}
        </p>
      </header>
      <div className="queue-grid">
        <QueueList title="Appointments" entries={appointments} />
        <QueueList title="Walk-ins" entries={walkIns} />
      </div>
    </main>
  );
}
