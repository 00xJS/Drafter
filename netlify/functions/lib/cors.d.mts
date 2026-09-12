export function corsHeaders(req: Request): Record<string, string> | null
export function withCors<C = unknown>(handler: (req: Request, context: C) => Promise<Response> | Response): (req: Request, context: C) => Promise<Response>
export function withPublicCors<C = unknown>(
  handler: (req: Request, context: C) => Promise<Response> | Response,
  opts?: { methods?: string; headers?: string; expose?: string; maxAge?: number },
): (req: Request, context: C) => Promise<Response>
