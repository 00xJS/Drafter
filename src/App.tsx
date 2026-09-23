import { Suspense, lazy, useEffect, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import { getSupabase, isSupabaseConfigured, storedUserId } from './supabase'
import { clearLocalData } from './idb'
import { APP_HOST } from '../shared/apphost.mts'
import { Landing } from './components/Landing'
import { Login } from './components/Login'
import { LockGate } from './components/LockGate'
import { SetPassword } from './components/SetPassword'
import { guardChunkLoads, preloadable, warm } from './lazyload'
import { clearAuthorizeRequest, pendingAuthorizeRequest } from './oauthRequest'

// The planner (and everything it imports) loads only after the gate — the
// public landing page ships a fraction of the bundle.
const loadPlanner = () => import('./components/Planner')
const Planner = lazy(loadPlanner)

/**
 * Start fetching the planner now: main.tsx does, for a device that will open
 * straight to it, so its chunk comes in beside this device's saved copy
 * rather than after the gate has decided.
 */
export function preloadPlanner(): void {
  void loadPlanner().catch(() => {
    /* fetched again when it renders; guardChunkLoads handles one that will not load */
  })
}
// "Connect Claude?" is for the rare visit an assistant sends here
// (/oauth/authorize, kept by main.tsx), so its chunk is fetched only then.
const ConnectAssistantSheet = preloadable(() => import('./components/ConnectAssistantSheet').then(m => m.ConnectAssistantSheet), 'ConnectAssistantSheet')

// A chunk that will not load (usually a page older than the latest deploy)
// reloads the page, once; see lazyload.ts.
guardChunkLoads()

/** Local mode is for private hosts only — a public deploy without a backend fails closed. */
function isPrivateHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    // the iOS shell's own host: the bundle is served from inside the app, not
    // fetched from anywhere, so a build with no backend is a private one
    hostname === APP_HOST ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost') ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
}

/** Whether the address holds an auth redirect (a magic, invite or reset link) auth-js has still to read. */
export function authRedirect(loc: Pick<Location, 'hash' | 'search'> | undefined = globalThis.window?.location): boolean {
  return /(?:^|[#?&])(?:access_token|refresh_token|code|token_hash|type|error_description)=/.test(`${loc?.hash ?? ''}&${loc?.search ?? ''}`)
}

/** What a waiting assistant connection request (src/oauthRequest.ts) asks of the gate. */
export type AuthorizeRoute = 'none' | 'no-account' | 'sign-in' | 'consent'

/**
 * Where a captured /oauth/authorize request takes the gate: nowhere when none
 * waits; a "needs an account" card when this copy has no backend to hold a
 * connection (local mode); Login, straight away and saying why, when signed
 * out; the consent sheet over the planner when signed in.
 */
export function authorizeRoute(pending: URLSearchParams | null, session: Session | boolean | null, backend: boolean): AuthorizeRoute {
  if (!pending) return 'none'
  if (!backend) return 'no-account'
  return session ? 'consent' : 'sign-in'
}

/**
 * "Not you?" on the consent sheet. Signs out the way the rest of the app does
 * — local copy wiped, a fresh page — so the account that signs in next never
 * meets this one's data still in memory. The request stays in sessionStorage,
 * so the fresh page asks the right account straight away.
 */
async function signOutForAnotherAccount() {
  await getSupabase()?.auth.signOut()
  await clearLocalData()
  window.location.reload()
}

/**
 * Gate: public visitors see the landing page; the planner mounts only after sign-in.
 *
 * Signed in is decided from the session auth-js keeps on this device
 * (storedUserId: no network, no token refresh), not from getSession(). With an
 * access token past its hour, getSession() refreshes it over the network
 * first — offline that took about 25 seconds of blank screen and then
 * answered no session at all, while the session was still on the device, and
 * the offline planner opened as the sign-in page. Now a device signed in opens
 * to its planner at once; a session that turns out to be dead ends the way any
 * does (SIGNED_OUT: the local copy wiped, the sign-in overlay on top).
 */
export default function App() {
  const supabaseOn = isSupabaseConfigured()
  const [session, setSession] = useState<Session | null>(null)
  // The account whose session this device holds, whether or not its token is
  // fresh — unless the address carries a sign-in or password-reset link:
  // auth-js reads that first, and a reset link must reach SetPassword before
  // anything of the planner draws.
  const [storedUser, setStoredUser] = useState<string | null>(() => (supabaseOn && !authRedirect() ? storedUserId() : null))
  // with a session on the device there is nothing to wait for; without one, getSession says quickly
  const [authReady, setAuthReady] = useState(() => !supabaseOn || storedUser !== null)
  const signedIn = !!session || storedUser !== null
  const [showLogin, setShowLogin] = useState(false)
  /** A recovery link brought us here: nothing else may draw until a new password is set. */
  const [recovering, setRecovering] = useState(false)
  // an assistant's connection request, kept by main.tsx before the first render
  const [pending, setPending] = useState(() => pendingAuthorizeRequest())
  // once signed in, a lost session never unmounts the planner (see below):
  // remembered as the session arrives, so the render that sees it already knows
  const [hadSession, setHadSession] = useState(false)
  if (signedIn && !hadSession) setHadSession(true)
  const route = authorizeRoute(pending, signedIn, supabaseOn)
  const dropRequest = () => {
    clearAuthorizeRequest()
    setPending(null)
  }

  // fetch the sheet while the gate decides, or while the user signs in
  useEffect(() => {
    if (pending && supabaseOn) warm(ConnectAssistantSheet.preload)
  }, [pending, supabaseOn])

  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session)
      // No session back while one is still stored: its token could not be
      // refreshed (offline). The device is still signed in; auth-js refreshes
      // it when the network returns, or says SIGNED_OUT if it cannot.
      setStoredUser(data.session?.user.id ?? storedUserId())
      setAuthReady(true)
    })
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      // a session ending for ANY reason (sign-out here, elsewhere, or revoked)
      // must take the local copy of the data with it
      if (event === 'SIGNED_OUT') {
        clearLocalData().catch(() => {})
        setStoredUser(null)
      } else if (s) setStoredUser(s.user.id)
      // A "reset your password" link signs this browser in for exactly one
      // purpose. Without this the link would open the planner with the
      // forgotten password still on the account (v3.25).
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      // The sync cursor is reset in the store, which knows whether this device
      // actually has local rows — supabase re-emits SIGNED_IN on every tab
      // focus, so resetting it from here made every focus a full exchange.
      setSession(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!authReady) return null
  // above every other route, including the landing page and the consent sheet
  if (recovering) return <SetPassword email={session?.user.email ?? undefined} onDone={() => setRecovering(false)} />
  // fail closed: a public deploy with no backend gets the landing page with sign-in hidden
  if (!supabaseOn && import.meta.env.PROD && !isPrivateHost(window.location.hostname)) {
    return <Landing configured={false} />
  }
  // local mode keeps everything on this device: there is no account to connect
  if (route === 'no-account') return <Login connecting onBack={dropRequest} />
  if (supabaseOn && !signedIn && !hadSession) {
    // an assistant is waiting: straight to sign-in, saying why, no landing page on the way
    if (route === 'sign-in') return <Login connecting onBack={dropRequest} />
    return showLogin ? <Login onBack={() => setShowLogin(false)} /> : <Landing configured onSignIn={() => setShowLogin(true)} />
  }
  // one stable tree position for Planner so mid-use session loss never unmounts
  // open work — it just gets a re-auth overlay on top
  return (
    <>
      <Suspense fallback={null}>
        <Planner />
      </Suspense>
      {/* over the planner; the lock screen and the re-auth overlay both sit above it */}
      {route === 'consent' && pending && session && (
        <Suspense fallback={null}>
          <ConnectAssistantSheet params={pending} email={session.user.email ?? ''} onDone={dropRequest} onSignOut={signOutForAnotherAccount} />
        </Suspense>
      )}
      {supabaseOn && signedIn && <LockGate />}
      {supabaseOn && !signedIn && (
        <div className="auth-overlay">
          <Login connecting={route === 'sign-in'} onBack={route === 'sign-in' ? dropRequest : undefined} />
        </div>
      )}
    </>
  )
}
