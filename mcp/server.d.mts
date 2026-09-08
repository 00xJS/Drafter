// Loose declarations for the pieces of the MCP server the tests exercise.
// The server is dependency-free JavaScript; these types only keep tsc quiet.

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] }
  run(args: Record<string, unknown>): Promise<unknown>
}

export declare const TOOLS: ToolDef[]
export declare function startStdio(): void
export declare function syncWrite(items: Record<string, unknown>[]): Promise<Record<string, any>[]>
export declare function writeItem(item: Record<string, unknown>): Promise<Record<string, any>>
export declare function fetchJournal(): Promise<Record<string, any>[]>
export declare function assertDayKey(day: unknown): string
export declare function resolveContext(
  all: Record<string, unknown>[],
  ctx: { peopleIds?: unknown; placeId?: unknown; placeName?: unknown },
): { peopleIds?: string[]; placeId?: string }
export declare function summarizeTask(t: Record<string, any>): Record<string, any>
export declare function summarizePlace(p: Record<string, any>, tasks?: Record<string, any>[], people?: Record<string, any>[]): Record<string, any>
