import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { Landing } from './components/Landing'
import { Login } from './components/Login'

// The planner (and everything it imports) loads only after the gate — the
// public landing page ships a fraction of the bundle.
const Planner = lazy(() => import('./components/Planner'))

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

/** Gate: public visitors see the landing page; the planner mounts only after sign-in. */
export default function App() {
  const supabaseOn = isSupabaseConfigured()
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabaseOn)
  const [showLogin, setShowLogin] = useState(false)
  const hadSession = useRef(false)
  if (session) hadSession.current = true

  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
    })
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!authReady) return null
  // fail closed: a public deploy with no backend gets the landing page with sign-in hidden
  if (!supabaseOn && import.meta.env.PROD && !isPrivateHost(window.location.hostname)) {
    return <Landing configured={false} />
  }
  if (supabaseOn && !session && !hadSession.current) {
    return showLogin ? <Login onBack={() => setShowLogin(false)} /> : <Landing configured onSignIn={() => setShowLogin(true)} />
  }
  // one stable tree position for Planner so mid-use session loss never unmounts
  // open work — it just gets a re-auth overlay on top
  return (
    <>
      <Suspense fallback={null}>
        <Planner />
      </Suspense>
      {supabaseOn && !session && (
        <div className="auth-overlay">
          <Login />
        </div>
      )}
    </>
  )
}
