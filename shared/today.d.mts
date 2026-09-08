import { Task } from '../src/types'

export declare const OPEN: string[]
export declare const DAY_MS: number
export declare function bucketByDue(
  tasks: Task[],
  opts: { today: string; dayKey: (iso: string) => string | null },
): { open: Task[]; overdue: Task[]; dueToday: Task[]; dueSoon: Task[] }
