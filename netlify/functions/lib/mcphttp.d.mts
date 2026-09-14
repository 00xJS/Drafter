export declare const MAX_BODY_BYTES: number
export declare const DEADLINE_MS: number
export declare const MCP_CORS: { methods: string; headers: string; expose: string }
/** The error_description a token made by hand gets once it has lapsed after 180 days unused. */
export declare const LAPSED_TEXT: string
export declare function resourceMetadataUrl(): string
export declare function mcpHandler(req: Request): Promise<Response>
export declare function mcpEndpoint(req: Request, context?: unknown): Promise<Response>
