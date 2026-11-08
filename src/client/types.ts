export type QueueStatus = 'checked_in' | 'shopping';

export interface QueueEntry {
  id: number;
  firstName: string;
  lastName: string;
  appointmentTime: string | null;
  checkInTime: string;
  status: QueueStatus;
  createdAt: string;
  updatedAt: string;
}
