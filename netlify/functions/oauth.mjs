// The OAuth server assistants connect through (netlify.toml rewrites the
// /.well-known/*, /oauth/register|token|revoke and /api/oauth/* paths here).
// The logic lives in lib/oauthserver.mjs; /oauth/authorize is the app itself.

import { oauthHandler } from './lib/oauthserver.mjs'

export default oauthHandler
