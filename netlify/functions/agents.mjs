// /api/agents — the signed-in app's view of its assistant connections: list,
// create a manual token (shown once), rename, revoke. Session-gated and
// app-only CORS, like feed.mjs. The logic lives in lib/agentauth.mjs.

import { withCors } from './lib/cors.mjs'
import { agentsHandler } from './lib/agentauth.mjs'

export default withCors(agentsHandler)
