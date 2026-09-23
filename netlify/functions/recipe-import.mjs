// Kitchen → a recipe's "Import from a link". The app posts { url } and gets
// back { recipe, sourceUrl } when the page carries schema.org Recipe data, or
// { text, title, sourceUrl } — the page's readable text — for the app to read
// with ✨ as it reads a paste. Signed-in accounts only, and the fetch refuses
// anything but a public web page: see lib/recipeimport.mjs. Twenty imports in
// ten minutes per account, counted across instances (lib/ratelimit.mjs).

import { withCors } from './lib/cors.mjs'
import { sharedWindow } from './lib/ratelimit.mjs'
import { recipeImportHandler } from './lib/recipeimport.mjs'

export default withCors(recipeImportHandler({ perUser: sharedWindow({ bucket: 'recipe-import', limit: 20, windowMs: 10 * 60_000 }) }))
