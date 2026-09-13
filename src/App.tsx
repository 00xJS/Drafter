import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { clearLocalData } from './idb'
import { Landing } from './components/Landing'
import { Login } from './components/Login'
import { LockGate } from './components/LockGate'
import { guardChunkLoads, preloadable, warm } from './lazyload'
import { clearAuthorizeRequest, pendingAuthorizeRequest } from './oauthRequest'

// The planner (and everything it imports) loads only after the gate — the
// public landing page ships a fraction of the bundle.
const Planner = lazy(() => import('./components/Planner'))
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
    hostname === '127.0.0.1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost') ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
}

/** What a waiting assistant connection request (src/oauthRequest.ts) asks of the gate. */
export type AuthorizeRoute = 'none' | 'no-account' | 'sign-in' | 'consent'

/**
 * Where a captured /oauth/authorize request takes the gate: nowhere when none
 * waits; a "needs an account" card when this copy has no backend to hold a
 * connection (local mode); Login, straight away and saying why, when signed
 * out; the consent sheet over the planner when signed in.
 */
export function authorizeRoute(pending: URLSearchParams | null, session: Session | null, backend: boolean): AuthorizeRoute {
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

/** Gate: public visitors see the landing page; the planner mounts only after sign-in. */
export default function App() {
  const supabaseOn = isSupabaseConfigured()
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabaseOn)
  const [showLogin, setShowLogin] = useState(false)
  // an assistant's connection request, kept by main.tsx before the first render
  const [pending, setPending] = useState(() => pendingAuthorizeRequest())
  const hadSession = useRef(false)
  if (session) hadSession.current = true
  const route = authorizeRoute(pending, session, supabaseOn)
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
      setAuthReady(true)
    })
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      // a session ending for ANY reason (sign-out here, elsewhere, or revoked)
      // must take the local copy of the data with it
      if (event === 'SIGNED_OUT') clearLocalData().catch(() => {})
      // The sync cursor is reset in the store, which knows whether this device
      // actually has local rows — supabase re-emits SIGNED_IN on every tab
      // focus, so resetting it from here made every focus a full exchange.
      setSession(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!authReady) return null
  // fail closed: a public deploy with no backend gets the landing page with sign-in hidden
  if (!supabaseOn && import.meta.env.PROD && !isPrivateHost(window.location.hostname)) {
    return <Landing configured={false} />
  }
  // local mode keeps everything on this device: there is no account to connect
  if (route === 'no-account') return <Login connecting onBack={dropRequest} />
  if (supabaseOn && !session && !hadSession.current) {
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
          <ConnectAssistantSheet params={pending} email={session.user.email ?? ''} onDone={dropRequest} onSignOut={() => void signOutForAnotherAccount()} />
        </Suspense>
      )}
      {supabaseOn && session && <LockGate />}
      {supabaseOn && !session && (
        <div className="auth-overlay">
          <Login connecting={route === 'sign-in'} onBack={route === 'sign-in' ? dropRequest : undefined} />
        </div>
      )}
    </>
  )
}
