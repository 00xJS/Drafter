export function corsHeaders(req: Request): Record<string, string> | null
export function withCors<C = unknown>(handler: (req: Request, context: C) => Promise<Response> | Response): (req: Request, context: C) => Promise<Response>
