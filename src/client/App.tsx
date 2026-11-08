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
    const heartbeatIntervalMs = 1000;
    const heartbeatTimeoutMs = 500;
    const reconnectDelayMs = 500;
    let retry: number | undefined;
    let heartbeat: number | undefined;
    let heartbeatTimeout: number | undefined;
    let socket: WebSocket;
    let stopped = false;
    let reconnectImmediately = true;
    let heartbeatId = 0;
    let awaitingHeartbeatId: number | undefined;

    const clearHeartbeat = () => {
      if (heartbeat) window.clearInterval(heartbeat);
      if (heartbeatTimeout) window.clearTimeout(heartbeatTimeout);
      heartbeat = undefined;
      heartbeatTimeout = undefined;
      awaitingHeartbeatId = undefined;
    };

    const markDisconnected = () => {
      setConnected(false);
      clearHeartbeat();
      if (socket.readyState === WebSocket.OPEN) socket.close();
    };

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.onopen = () => {
        setConnected(true);
        reconnectImmediately = true;
        const sendHeartbeat = () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const id = ++heartbeatId;
          awaitingHeartbeatId = id;
          socket.send(JSON.stringify({ action: 'ping', id }));
          if (heartbeatTimeout) window.clearTimeout(heartbeatTimeout);
          heartbeatTimeout = window.setTimeout(() => {
            if (awaitingHeartbeatId === id) markDisconnected();
          }, heartbeatTimeoutMs);
        };
        sendHeartbeat();
        heartbeat = window.setInterval(sendHeartbeat, heartbeatIntervalMs);
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as { type: string; id?: number; entries?: QueueEntry[] };
        if (message.type === 'pong' && message.id === awaitingHeartbeatId) {
          if (heartbeatTimeout) window.clearTimeout(heartbeatTimeout);
          heartbeatTimeout = undefined;
          awaitingHeartbeatId = undefined;
        } else if (message.type === 'queue.snapshot' && message.entries) {
          setEntries(message.entries);
        }
      };
      socket.onclose = () => {
        setConnected(false);
        clearHeartbeat();
        if (!stopped) {
          if (retry) window.clearTimeout(retry);
          const delay = reconnectImmediately ? 0 : reconnectDelayMs;
          reconnectImmediately = false;
          retry = window.setTimeout(connect, delay);
        }
      };
      socket.onerror = () => markDisconnected();
    };

    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      clearHeartbeat();
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
