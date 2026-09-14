// The stdio server: a proxy for the hosted /api/mcp, and nothing else. The
// tools are in tools.mjs and the protocol in protocol.mjs.

export declare const DEFAULT_MCP_URL: string
export declare function selectMode(env?: Record<string, string | undefined>): 'proxy' | 'unconfigured'
export declare function startStdio(env?: Record<string, string | undefined>): void
