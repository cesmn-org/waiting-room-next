import type { QueueEntry, QueueStatus } from './types';

export async function loadQueue(device?: 'tv' | 'tablet'): Promise<QueueEntry[]> {
  const path = device ? `/api/queue?device=${device}` : '/api/queue';
  const response = await fetch(path);
  if (!response.ok) throw new Error('Unable to load queue');
  return response.json() as Promise<QueueEntry[]>;
}

export async function mutateQueue(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: Record<string, unknown> = {},
) {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Mutation-Id': crypto.randomUUID() },
    body: method === 'DELETE' ? JSON.stringify({}) : JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Queue update failed');
}

export type QueueDraft = Pick<
  QueueEntry,
  'firstName' | 'lastName' | 'appointmentTime' | 'checkInTime'
> & { status?: QueueStatus };
