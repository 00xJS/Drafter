// Types for recipedrafts.mjs. The runtime is recipedrafts.mjs.

import type { Completion, CompletionInput } from './ai.mjs'
import type { startJob } from './aijobs.mjs'
import type { WriteAsOutcome } from './writeas.mjs'

type Row = { id?: string; user_id: string | null; data: any }
type Rest = (path: string, init?: RequestInit) => Promise<any>

export declare const NIGHTLY_LIMIT: number
export declare const PLANNED_DAYS: number
export declare const NIGHT_HOUR: number
export declare const NIGHT_RUNS: number
export declare const NIGHT_MS: number
export declare const MAX_TRIES: number
export declare const DRAFT_MS: number
export declare const JOB_MS: number

/** Live, named, and nothing to shop for: a recipe the sheet would offer. */
export declare function isBareRecipe(data: Record<string, any> | null | undefined): boolean
/** Whether this hourly run is one of the account's night runs (3, 4 and 5 in the morning where it is). */
export declare function recipeNightStarts(settings: { timezone?: string | null } | null | undefined, now: Date): boolean
/** The accounts whose night it is and whose household holds a recipe still bare. */
export declare function recipeNightAccounts(
  accounts: readonly { user_id?: string | null; timezone?: string | null }[] | null | undefined,
  rows: readonly { user_id: string | null; data: unknown }[] | null | undefined,
  peers: Map<string, Set<string>> | null | undefined,
  now: Date,
): string[]
/** Hand tonight's drafts to the background function: null once taken, or with nothing to hand; otherwise what went wrong. */
export declare function startRecipeNight(userIds: readonly string[], now: Date, origin: string, opts?: { start?: typeof startJob }): Promise<string | null>

export interface RecipePick {
  /** The recipe's data as its owner reads it, with `ownerId`. */
  recipe: Record<string, any>
  ownerId: string
  /** Who the draft is written as: the recipe's owner, or whoever holds the row already there. */
  writer: string
  /** The draft row already there: only ever one the job noted as tried. */
  row: Row | null
  plannedOn: string | null
}

export interface RecipePlan {
  groups: { key: string; members: string[]; room: number; picks: RecipePick[]; waiting: number }[]
  stale: Row[]
}

export declare function planRecipeDrafts(input: {
  rows: readonly Row[]
  drafts: readonly Row[]
  settings: readonly { user_id: string; timezone?: string | null }[]
  peers: Map<string, Set<string>> | null | undefined
  named: Iterable<string>
  at: Date
}): RecipePlan

export type DraftOutcome = { state: 'drafted' | 'no answer' | 'stepped aside' } | { state: 'failed'; why: string; stop?: boolean }

export declare function draftRecipe(
  pick: Pick<RecipePick, 'recipe' | 'ownerId' | 'writer' | 'row'>,
  ctx: {
    read: Rest
    write: (ownerId: string, items: Record<string, unknown>[], opts?: { handOver?: boolean }) => Promise<WriteAsOutcome>
    ask: (input: CompletionInput) => Promise<Completion>
    deadline: number
    now: () => number
  },
): Promise<DraftOutcome>

export declare function runRecipeDrafts(
  job: Record<string, unknown>,
  deps?: {
    rest?: Rest
    restAll?: (path: string) => Promise<any[]>
    writeAs?: (ownerId: string, items: Record<string, unknown>[], opts?: { handOver?: boolean }) => Promise<WriteAsOutcome>
    complete?: (input: CompletionInput) => Promise<Completion>
    now?: () => number
  },
): Promise<{ counts: Record<string, number>; failures: string[] }>
