// /api/mcp — Drafter's hosted MCP endpoint (netlify.toml rewrites the public
// path here). Everything lives in lib/mcphttp.mjs so tests can import it: no
// declaration file may sit at this level, because every top-level file in
// netlify/functions ships as a function.

import { mcpEndpoint } from './lib/mcphttp.mjs'

export default mcpEndpoint
