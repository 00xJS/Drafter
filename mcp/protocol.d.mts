import type { ToolContext, ToolDef } from './tools.mjs'

export type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: any; error?: { code: number; message: string } }

export interface HandleOptions {
  tools?: ToolDef[]
  scopes?: readonly string[]
  ctx?: ToolContext | (() => ToolContext | Promise<ToolContext>)
  serverInfo?: { name: string; version: string }
  instructions?: string | ((ctx: ToolContext) => string)
  deadlineMs?: number
  onToolCall?(call: { name: string; ms: number; isError: boolean }): void
}

export declare const PROTOCOL_VERSIONS: readonly string[]
export declare const SERVER_INFO: { name: string; version: string }
export declare const SCOPE_REFUSAL: string
export declare const DEADLINE_TEXT: string
export declare const OUT_OF_TIME_TEXT: string
export declare function negotiate(requested: unknown): string
export declare function instructionsFor(opts?: { tz?: string; scopes?: readonly string[] }): string
export declare function hasInitialize(parsed: unknown): boolean
export declare function handleMessage(msg: unknown, opts?: HandleOptions): Promise<JsonRpcResponse | null>
export declare function handleBody(
  body: unknown,
  opts?: HandleOptions,
): Promise<{ status: 200; json: JsonRpcResponse | JsonRpcResponse[] } | { status: 202; json?: undefined } | { status: 400; json: JsonRpcResponse }>
