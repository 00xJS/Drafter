import { Platform, Priority, ProjectStatus, RecurrenceFreq, Task, TaskStatus } from '../src/types.js'

export declare const PLATFORMS: Platform[]
export declare const TASK_STATUSES: TaskStatus[]
export declare const PROJECT_STATUSES: ProjectStatus[]
export declare const PRIORITIES: Priority[]
export declare const RECURRENCE_FREQS: RecurrenceFreq[]
export declare const SOCIAL_PROJECT_ID: string
export declare function newerStamp(prevIso?: string): string
export declare function isLegacyPost(raw: unknown): boolean
/** A pre-v3 post as a task; any other record comes back as it was. Callers pass a stored row's `data`. */
export declare function legacyPostToTask(raw: unknown): Record<string, any>
export declare function localDate(iso: string | number, tz?: string | null): string | null
export declare function isUntimed(iso: string, tz?: string | null): boolean
export declare function localMidnightIso(dateKey: string): string | null
export declare function spawnId(taskId: string, freq: string, nextDueIso: string): string
export declare function nextOccurrence(task: Task, uidFn: () => string): Task | null
/** Open next occurrences of one repeating chore beyond the one every device keeps: the ids to put in the Trash. */
export declare function duplicateSpawns(items: readonly { kind?: string; id: string; status?: string; recurrence?: unknown; deletedAt?: string; purged?: boolean }[]): string[]
/** The same, each with `keptId`: the occurrence every device keeps in its place. */
export declare function duplicateSpawnPairs(
  items: readonly { kind?: string; id: string; status?: string; recurrence?: unknown; deletedAt?: string; purged?: boolean }[],
): { id: string; keptId: string }[]
export declare function isMineTask(task: { kind?: string; ownerId?: string; assigneeId?: string }, myId?: string | null): boolean
