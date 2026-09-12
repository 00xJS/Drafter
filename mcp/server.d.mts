// The stdio server: transport and mode only. The tools are in tools.mjs,
// the protocol in protocol.mjs and the database access in data.mjs.

export declare const DEFAULT_MCP_URL: string
export declare function selectMode(env?: Record<string, string | undefined>): 'proxy' | 'service' | 'unconfigured'
export declare function startStdio(env?: Record<string, string | undefined>): void
