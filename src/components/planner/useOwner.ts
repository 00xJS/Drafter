import { useEffect, useState } from 'react'
import { fetchAdminMe } from '../../admin'
import { getSupabase } from '../../supabase'
import { browserKV, type KV } from '../../syncstate'

/**
 * The answer /api/admin last gave on this install, and for which account.
 * The check used to run on every auth event — each token refresh, so each
 * return to the app — and every one woke the admin function (about a
 * megabyte of it) to say what it had said before. Now an account is asked
 * about once, and again only when another account signs in here. A drafter:*
 * key, so sign-out forgets it. It only decides whether Admin's button shows:
 * every Admin action is checked by the server itself.
 */
export const OWNER_KEY = 'drafter:owner'

interface OwnerAnswer {
  userId: string
  isOwner: boolean
}

export function readOwnerAnswer(kv: KV = browserKV): OwnerAnswer | null {
  try {
    const raw: unknown = JSON.parse(kv.getItem(OWNER_KEY) ?? 'null')
    if (raw && typeof raw === 'object' && typeof (raw as OwnerAnswer).userId === 'string' && typeof (raw as OwnerAnswer).isOwner === 'boolean') return raw as OwnerAnswer
  } catch {
    /* unreadable: asked again */
  }
  return null
}

function keepOwnerAnswer(answer: OwnerAnswer, kv: KV = browserKV): void {
  try {
    kv.setItem(OWNER_KEY, JSON.stringify(answer))
  } catch {
    /* storage full or blocked: asked again next launch */
  }
}

/** Whether the signed-in account is the site owner — the one who sees Admin. */
export function useOwner() {
  const [isOwner, setIsOwner] = useState(false)

  // Site-owner Admin entry: JWT email vs app_config.owner_email (server-side).
  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    let cancelled = false
    /** The account asked about this launch, while the question is out or once answered. */
    let asked: string | null = null
    const check = (userId: string) => {
      const known = readOwnerAnswer()
      if (known?.userId === userId) {
        setIsOwner(known.isOwner)
        return
      }
      if (asked === userId) return
      asked = userId
      fetchAdminMe()
        .then(r => {
          keepOwnerAnswer({ userId, isOwner: !!r.isOwner })
          if (!cancelled) setIsOwner(!!r.isOwner)
        })
        .catch(() => {
          // no answer (offline, the server down): asked again at the next auth event
          if (asked === userId) asked = null
          if (!cancelled) setIsOwner(false)
        })
    }
    sb.auth.getSession().then(({ data }) => {
      if (data.session) check(data.session.user.id)
    })
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      if (session) check(session.user.id)
      else setIsOwner(false)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  return { isOwner }
}
