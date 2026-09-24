import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import { inAppLink } from '../links'

// A household message's push opens the chat on its Household side: the web's
// notification tap loads the site at `?chat=household`, and the iPhone app is
// handed the same link's path and query. Either way the one reader of inbound
// links (useDeepLinks) moves the chat to the household's thread and puts the
// chat up, and writes nothing.

function links({ loaded = true } = {}) {
  const calls: string[] = []
  const log = (name: string) => vi.fn((...args: unknown[]) => void calls.push(`${name} ${JSON.stringify(args)}`))
  const deps = {
    store: { loaded, journal: [], tasks: [], people: [], places: [], upsert: log('upsert'), remove: log('remove') },
    showToast: log('toast'),
    setEditor: log('editor'),
    setView: log('view'),
    setPushed: log('pushed'),
    setChatSide: log('chatSide'),
    changeStatus: log('changeStatus'),
  } as unknown as Parameters<typeof useDeepLinks>[0]
  let apply: (raw: string, host?: string, fromNotification?: boolean) => void = () => {}
  function Shell() {
    const { applyLinkRef } = useDeepLinks(deps)
    apply = (raw, host, fromNotification) => applyLinkRef.current(raw, host, fromNotification)
    return null
  }
  renderToString(<Shell />)
  return { apply, calls }
}

describe('a household message’s push', () => {
  it('opens the chat on the household’s thread, and nothing more', () => {
    const { apply, calls } = links()
    apply('/?chat=household')
    expect(calls).toEqual(['chatSide ["household"]', 'pushed ["chat"]'])
  })

  it('does the same from the iPhone app, handed the site’s link as its own', () => {
    const { apply, calls } = links()
    apply(inAppLink('https://drafter.example/?chat=household'))
    expect(calls).toEqual(['chatSide ["household"]', 'pushed ["chat"]'])
  })

  it('waits, like every link, until the planner has loaded', () => {
    const { apply, calls } = links({ loaded: false })
    apply('/?chat=household')
    expect(calls).toEqual([])
  })

  it('names no other thread, and writes nothing whatever rides along', () => {
    const { apply, calls } = links()
    apply('/?chat=assistant')
    apply('/?chat=household&act=done', '', true)
    expect(calls).toEqual(['chatSide ["household"]', 'pushed ["chat"]'])
  })
})
