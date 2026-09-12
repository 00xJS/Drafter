import { useEffect, useState } from 'react'
import { fetchAdminMe } from '../../admin'
import { getSupabase } from '../../supabase'

/** Whether the signed-in account is the site owner — the one who sees Admin. */
export function useOwner() {
  const [isOwner, setIsOwner] = useState(false)

  // Site-owner Admin entry: JWT email vs app_config.owner_email (server-side).
  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    let cancelled = false
    const check = () => {
      fetchAdminMe()
        .then(r => {
          if (!cancelled) setIsOwner(!!r.isOwner)
        })
        .catch(() => {
          if (!cancelled) setIsOwner(false)
        })
    }
    sb.auth.getSession().then(({ data }) => {
      if (data.session) check()
    })
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      if (session) check()
      else setIsOwner(false)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  return { isOwner }
}
