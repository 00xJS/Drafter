// Types for mcp/tools.mjs. The tools are dependency-free JavaScript; these only keep tsc honest.

import type { Clock } from '../shared/clock.mjs'
import type { Item, RestData } from './data.mjs'

export type Scope = 'read' | 'write' | 'journal'

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolContext {
  db: RestData
  clock: Clock
  scopes: readonly Scope[]
  userId: string | null
  newId(): string
  rand(): string
}

export interface ToolDef {
  name: string
  description: string
  scope: Scope
  annotations: ToolAnnotations
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] }
  /** `args` is whatever the client sent: each tool checks its own. */
  run(args: Record<string, any>, ctx: ToolContext): Promise<unknown>
}

export declare const SCOPES: readonly Scope[]
export declare const TOOLS: ToolDef[]
export declare function toolsFor(scopes: readonly string[] | null | undefined, tools?: ToolDef[]): ToolDef[]
export declare function defaultNewId(): string
export declare function defaultRand(): string
export declare function createContext(opts: {
  db: RestData
  clock: Clock
  scopes?: readonly Scope[]
  userId?: string | null
  newId?: () => string
  rand?: () => string
}): ToolContext
export declare function assertDayKey(day: unknown): string
export declare function resolveContext(
  all: Record<string, unknown>[],
  ctx: { peopleIds?: unknown; placeId?: unknown; placeName?: unknown },
): { peopleIds?: string[]; placeId?: string }
export declare function summarizeTask(t: Item): Record<string, any>
export declare function summarizePlace(p: Item, tasks?: Item[], people?: Item[], meals?: Item[], nowMs?: number): Record<string, any>
