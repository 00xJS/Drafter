import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Small silent failures in Settings. Email in's Create, Reset and Turn off
// had no catch and no busy state, Reset and Turn off acted on a single tap,
// and Copy said nothing either way. Household's Add emptied the typed email
// even when the invitation was refused.

const env = vi.hoisted(() => ({ calls: [] as string[], answer: (_action: string): Promise<{ inboundUrl: string | null }> => Promise.resolve({ inboundUrl: null }) }))

vi.mock('../calendars', async importOriginal => ({
  ...(await importOriginal<typeof import('../calendars')>()),
  inboundAction: (action: string) => {
    env.calls.push(action)
    return env.answer(action)
  },
}))

import { ConfirmButton } from '../components/ConfirmButton'
import { EmailIn, copyText } from '../components/settings/EmailIn'
import { sendInvite } from '../components/settings/Household'
import type { SettingsCtx } from '../components/settings/context'
import { button, elements, press, settled, textOf, type El } from './rendered'

const ADDRESS = 'https://drafter.example/api/inbound?token=abc'
const ctx = (inboundUrl: string | null) => ({ feed: { feed: { configured: true, inboundUrl }, setFeed: vi.fn(), feedBusy: false } }) as unknown as SettingsCtx
const failures = (tree: ReactNode) => elements(tree).filter(e => e.type === 'p' && e.props.role === 'alert')

afterEach(() => {
  env.calls = []
  env.answer = () => Promise.resolve({ inboundUrl: null })
  vi.unstubAllGlobals()
})

describe('Settings → Email in', () => {
  it('says why Create failed, under it, and lets it be tried again', () => {
    env.answer = () => {
      // refused at once, so the failure lands inside the render that pressed it
      throw new Error('The server refused: email in is not set up.')
    }
    const tree = settled(EmailIn, ctx(null), t => press(t, 'Create my email-in address'))
    expect(failures(tree).map(e => textOf(e.props.children))).toEqual(['The server refused: email in is not set up.'])
    expect(button(tree, 'Create my email-in address').props.disabled).toBe(false)
  })

  it('shows Creating… while it is on its way, and a second tap sends nothing more', () => {
    env.answer = () => new Promise(() => {})
    const tree = settled(EmailIn, ctx(null), t => press(t, 'Create my email-in address'))
    const creating = button(tree, 'Creating…')
    expect(creating.props.disabled).toBe(true)
    ;(creating.props.onClick as () => void)()
    expect(env.calls).toEqual(['inbound-enable'])
  })

  it('asks before Reset and Turn off, which stop an address set up in a forwarding rule', () => {
    const tree = settled(EmailIn, ctx(ADDRESS), () => {})
    const confirms = elements(tree).filter((e): e is El => e.type === ConfirmButton)
    expect(confirms.map(c => textOf(c.props.children))).toEqual(['Reset', 'Turn off'])
    expect(confirms.every(c => typeof c.props.confirmLabel === 'string' && c.props.confirmLabel)).toBe(true)
    // nothing is sent until the second, confirming tap
    expect(env.calls).toEqual([])
    ;(confirms[0].props.onConfirm as () => void)()
    expect(env.calls).toEqual(['inbound-rotate'])
  })

  it('says Resetting… on the one that is running', () => {
    env.answer = () => new Promise(() => {})
    const tree = settled(EmailIn, ctx(ADDRESS), t => {
      const reset = elements(t).find(e => e.type === ConfirmButton && textOf(e.props.children) === 'Reset')!
      ;(reset.props.onConfirm as () => void)()
    })
    const labels = elements(tree)
      .filter(e => e.type === ConfirmButton)
      .map(c => textOf(c.props.children))
    expect(labels).toEqual(['Resetting…', 'Turn off'])
  })

  it('catches a refusal that comes later, rather than letting it escape the tap', async () => {
    env.answer = () => Promise.reject(new Error('Offline'))
    const tree = settled(EmailIn, ctx(null), () => {})
    ;(button(tree, 'Create my email-in address').props.onClick as () => void)()
    // an uncaught rejection would fail this run; give it the turn to surface
    await new Promise(r => setTimeout(r, 0))
    expect(env.calls).toEqual(['inbound-enable'])
  })

  it('knows whether Copy reached the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyText(ADDRESS)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith(ADDRESS)
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new DOMException('Write permission denied.', 'NotAllowedError')
        },
      },
    })
    await expect(copyText(ADDRESS)).resolves.toBe(false)
    // a web view with no clipboard at all
    vi.stubGlobal('navigator', {})
    await expect(copyText(ADDRESS)).resolves.toBe(false)
  })
})

describe('Settings → Household → Add', () => {
  it('keeps the typed email when the invitation is refused', async () => {
    const clear = vi.fn()
    await expect(
      sendInvite('maria@exmaple.com', {
        invite: async () => {
          throw new Error('No account uses that email.')
        },
        clear,
      }),
    ).rejects.toThrow('No account uses that email.')
    expect(clear).not.toHaveBeenCalled()
  })

  it('empties it once the invitation has gone out', async () => {
    const order: string[] = []
    await sendInvite('maria@example.com', {
      invite: async email => void order.push(`invite ${email}`),
      clear: () => void order.push('clear'),
    })
    expect(order).toEqual(['invite maria@example.com', 'clear'])
  })
})
