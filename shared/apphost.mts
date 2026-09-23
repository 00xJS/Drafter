// What this app is called, in the one place everything that has to say it out
// loud can read (v3.25).
//
// The iOS shell serves the same web bundle from inside a WKWebView, and the
// host it serves it from is what iOS shows when it asks permission for
// anything: "localhost would like to use your location". Capacitor's default
// hostname is literally `localhost`, so that is what the owner was asked about
// — a name that belongs to no app and reassures nobody.
//
// Changing it changes the web origin, and a web origin owns its storage: the
// first launch after the change starts with an empty IndexedDB and syncs the
// account down again. Nothing on the server moves. That cost is paid once, on
// the next rebuild of each phone.
//
// Dependency-free ESM: capacitor.config.ts, the app and the Netlify CORS
// allow-list all read it.

/** The name a person reads. Title case, because people read it. */
export const APP_NAME = 'Drafter'

/**
 * The host the iOS shell serves the bundle from — a hostname, so lower case.
 * This is the word iOS puts in its permission prompts.
 */
export const APP_HOST = 'drafter'

/** The iOS shell's web origin. */
export const APP_ORIGIN = `capacitor://${APP_HOST}`

/**
 * Every origin the hosted API answers to from the app shell. The old one stays
 * for as long as a phone might still be running a bundle from before the
 * change: a device that has not been rebuilt is not a device that should stop
 * syncing.
 */
export const APP_ORIGINS = [APP_ORIGIN, 'capacitor://localhost']
