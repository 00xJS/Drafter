// Find address: POST /api/geocode { q, near?, area? } — signed-in accounts
// only. A place's name is looked up on OpenStreetMap (Nominatim) near the
// user's area, and up to five candidates come back for them to pick from.
// Everything it does, the one-a-second gate included, is in lib/geocode.mjs.

import { withCors } from './lib/cors.mjs'
import { createGeocodeHandler } from './lib/geocode.mjs'

export default withCors(createGeocodeHandler())
