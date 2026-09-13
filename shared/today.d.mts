import { Project, Task } from '../src/types.js'

export declare const OPEN: string[]
export declare const DAY_MS: number
export declare function bucketByDue(
  tasks: Task[],
  opts: { today: string; dayKey: (iso: string) => string | null },
): { open: Task[]; overdue: Task[]; dueToday: Task[]; dueSoon: Task[] }

// focusOn / focusBy are typed structurally: Task gains them in src/types.ts (B1).
export declare function isFocusFor(
  task: { focusOn?: string; focusBy?: string } | null | undefined,
  dayKey: string,
  userId?: string | null,
): boolean
export declare function focusTasks<T extends { status: string; focusOn?: string; focusBy?: string; deletedAt?: string }>(
  tasks: readonly T[],
  dayKey: string,
  userId?: string | null,
): T[]
export declare function nextUp<T extends Task>(
  tasks: readonly T[],
  projects: readonly Pick<Project, 'id' | 'status'>[],
  limit?: number,
  now?: Date,
  pinnedTitles?: readonly string[],
  exclude?: ReadonlySet<string>,
): { task: T; reason: string; score: number }[]
