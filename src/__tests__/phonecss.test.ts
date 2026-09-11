import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')

/** Every `prop: …;` declaration in the sheet, paired with its property name. */
function declarations(): { prop: string; value: string }[] {
  const out: { prop: string; value: string }[] = []
  // strip comments first: they document the rules below and mention the bans
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of bare.matchAll(/([-a-z]+)\s*:\s*([^;{}]+);/g)) out.push({ prop: m[1], value: m[2] })
  return out
}

describe('phone chrome: the keyboard is subtracted exactly once', () => {
  // capacitor.config.ts runs the keyboard at resize: 'native', so iOS shrinks
  // the WebView itself. Any CSS that also spends --keyboard-h as a layout inset
  // subtracts the keyboard a second time and collapses the sheet it is on.
  it('never spends --keyboard-h as a layout inset', () => {
    const inset = /^(padding|margin|inset|top|right|bottom|left|height|max-height|min-height|translate)/
    const offenders = declarations()
      .filter(d => d.value.includes('--keyboard-h'))
      .filter(d => inset.test(d.prop))
      .map(d => `${d.prop}: ${d.value.trim()}`)
    expect(offenders).toEqual([])
  })

  it('keeps --keyboard-h defined as a signal other rules can read', () => {
    expect(css).toMatch(/--keyboard-h:\s*0px/)
  })

  it('slides the fixed tab bar out of the way instead of leaving it over the caret', () => {
    expect(css).toMatch(/\.keyboard-open \.tabs-compact\s*\{[^}]*translateY\(100%\)/)
  })

  it('takes the hidden tab bar out of the focus and VoiceOver order too', () => {
    // off-screen is not gone: without visibility the five buttons stay tabbable
    expect(css).toMatch(/\.keyboard-open \.tabs-compact\s*\{[^}]*visibility:\s*hidden/)
  })
})

/** Specificity of one comma-free selector, as [ids, classes, elements]. */
function specificity(sel: string): [number, number, number] {
  let ids = 0
  let classes = 0
  let elements = 0
  // :not()/:is() take the specificity of their most specific argument; ours are
  // all single simple selectors, so summing the inner counts is exact here.
  let rest = sel.replace(/:(?:not|is)\(([^)]*)\)/g, (_, inner: string) => {
    const [a, b, c] = specificity(inner)
    ids += a
    classes += b
    elements += c
    return ' '
  })
  rest = rest.replace(/::[\w-]+/g, () => (elements++, ' ')) // pseudo-elements are elements
  rest = rest.replace(/#[\w-]+/g, () => (ids++, ' '))
  rest = rest.replace(/\.[\w-]+/g, () => (classes++, ' '))
  rest = rest.replace(/\[[^\]]*\]/g, () => (classes++, ' '))
  rest = rest.replace(/:[\w-]+/g, () => (classes++, ' ')) // pseudo-classes
  for (const _ of rest.matchAll(/(?:^|[\s>+~])([a-z][\w-]*)/g)) elements++
  return [ids, classes, elements]
}

/** > 0 when `a` outranks `b`. */
function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

describe('phone chrome: no field may zoom the page', () => {
  // WKWebView zooms the whole page when a focused field computes under 16px and
  // never zooms back. The catch-all block must therefore WIN the cascade against
  // every class rule that sets a smaller size — being declared later is only
  // half of it, since 0,1,0 beats 0,0,1 no matter the order.
  const zoomGuard = css.lastIndexOf("[contenteditable='true']")
  // the arms sit between the `@media` opener and this rule's own `{`
  const guardSelector = css.slice(css.lastIndexOf('{', zoomGuard) + 1, css.indexOf('{', zoomGuard))
  const guardArms = guardSelector.split(',').map(s => s.trim()).filter(Boolean)
  const arm = (element: string) => guardArms.find(a => a.replace(/:not\([^)]*\)/g, '') === element) ?? ''

  it('has a 16px catch-all for phone fields', () => {
    expect(zoomGuard).toBeGreaterThan(-1)
    // a floor rather than a fixed size, so Dynamic Type can raise it — see
    // "lets a phone field grow past the anti-zoom floor" below. It still
    // resolves to exactly 16px at --type-scale: 1.
    expect(css.slice(zoomGuard)).toMatch(/font-size:\s*max\(16px,\s*1rem\)/)
    expect(guardArms.map(a => a.replace(/:not\([^)]*\)/g, '')).sort()).toEqual([
      "[contenteditable='true']",
      'input',
      'select',
      'textarea',
    ])
  })

  it('gives every arm enough specificity to outrank a class rule', () => {
    for (const arm of guardArms) {
      expect(compare(specificity(arm), [0, 1, 0]), `${arm} loses to a single class`).toBeGreaterThan(0)
    }
  })

  it('wins the cascade against every rule that sets a smaller field size', () => {
    // each smaller-field rule, paired with the element whose guard arm has to beat it
    const smaller: [string, string][] = [
      ['.search-input', 'input'],
      ['.notes-input', 'textarea'],
      ['.notes-editable', "[contenteditable='true']"],
      [".check-item input[type='date']", 'input'],
      ['.copy-row input', 'input'],
    ]
    for (const [sel, element] of smaller) {
      const rank = compare(specificity(arm(element)), specificity(sel))
      // a tie is fine only if the guard is declared later; a loss never is
      expect(rank, `${sel} outranks the ${element} arm of the anti-zoom guard`).toBeGreaterThanOrEqual(0)
      if (rank === 0) expect(css.lastIndexOf(sel), `${sel} is declared after the guard`).toBeLessThan(zoomGuard)
    }
  })
})

/** The sheet with its comments removed, so brace matching and rule lookup are exact. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The text between the braces of the block that opens at or after `at`. */
function blockBody(at: number): string {
  const open = bare.indexOf('{', at)
  let depth = 0
  for (let i = open; i < bare.length; i++) {
    if (bare[i] === '{') depth++
    else if (bare[i] === '}' && --depth === 0) return bare.slice(open + 1, i)
  }
  return ''
}

/** Where each `@media (pointer: coarse)` block starts, and what it contains. */
function coarseBlocks(): { at: number; body: string }[] {
  return [...bare.matchAll(/@media\s*\(pointer:\s*coarse\)/g)].map(m => ({ at: m.index, body: blockBody(m.index) }))
}

/** The declarations of the first rule in `scope` whose selector list matches `selector` exactly. */
function rule(scope: string, selector: string): string {
  const want = selector.split(',').map(s => s.trim()).join(',')
  // a selector chunk is whatever sits between the previous brace and the next `{`,
  // so this walks the innermost rules and steps over the @media openers around them
  for (const m of scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map(s => s.trim()).filter(Boolean).join(',') === want) return m[2]
  }
  return ''
}

/**
 * `--topbar-h` resolved at `scale`. Two shapes are accepted: the plain
 * `calc(<a>px + <b>px * var(--type-scale))`, and the phone's
 * `calc(<a>px + max(<floor>px, <pad>px + <b>px * var(--type-scale)))`, whose
 * fixed-size square only loses to the scaled control off the top of the clamp.
 */
function barHeight(declarations: string, scale: number): number {
  const m = /--topbar-h:\s*calc\(([\d.]+)px \+ (?:max\(([\d.]+)px,\s*(?:([\d.]+)px \+ )?)?([\d.]+)px \* var\(--type-scale\)\)?\)/.exec(
    declarations,
  )
  if (!m) throw new Error(`--topbar-h is not a scaled calc:\n${declarations}`)
  const scaled = Number(m[3] ?? 0) + Number(m[4]) * scale
  return Number(m[1]) + (m[2] ? Math.max(Number(m[2]), scaled) : scaled)
}

/**
 * The phone top bar as it really measures at `scale`: 10px + 10px of padding
 * and a 1px border around the taller of its two controls — the fixed 40px
 * `.new-post-btn` square, and the 🔍 / ⚙ `.btn.subtle` pair, which is the
 * inherited 14px * scale text at line-height 1.45 inside 7px * 2 of padding
 * and a 1px * 2 border. Neither button is hidden on a phone (only `.admin-btn`
 * and the brand wordmark are), so the token has to cover both.
 */
function measuredPhoneBar(scale: number): number {
  return 21 + Math.max(40, 14 * scale * 1.45 + 16)
}

describe('phone: the journal is writable with a thumb', () => {
  const coarse = coarseBlocks()
  const chipRule = coarse.find(b => rule(b.body, '.mood-chip'))

  it('gives the mood chips, the pills and the segments the 44pt floor', () => {
    expect(chipRule, 'no @media (pointer: coarse) rule for .mood-chip').toBeTruthy()
    expect(rule(chipRule!.body, '.mood-chip')).toMatch(/min-height:\s*44px/)
    expect(rule(chipRule!.body, '.mood-chip')).toMatch(/min-width:\s*44px/)
    // a bare min-height does nothing to a button whose text is its only content
    expect(rule(chipRule!.body, '.mood-chip')).toMatch(/display:\s*inline-flex/)
    // `button.` so the read-only `<span class="toggle on">` summary chips on
    // People and Places keep their 27pt
    const pills = coarse.find(b => rule(b.body, 'button.toggle, button.seg'))
    expect(pills, 'no @media (pointer: coarse) rule for .toggle/.seg').toBeTruthy()
    expect(rule(pills!.body, 'button.toggle, button.seg')).toMatch(/min-height:\s*44px/)
    expect(rule(pills!.body, 'button.toggle, button.seg')).toMatch(/display:\s*inline-flex/)
    // inline-flex strips the whitespace between a label and its adjacent count
    // span ("All12"), so the gap has to put the separator back
    expect(rule(pills!.body, 'button.toggle, button.seg')).toMatch(/gap:\s*4px/)
  })

  it('gives the row\u2019s escape hatch the same floor as the pills beside it', () => {
    // "+ Who" / "Hide" is a .btn, not a .toggle, and it is the only way to the
    // rest of the household — a 34px target in a row of 44px ones
    const esc = coarse.find(b => rule(b.body, '.platform-toggles .btn'))
    expect(esc, 'no @media (pointer: coarse) rule for .platform-toggles .btn').toBeTruthy()
    expect(rule(esc!.body, '.platform-toggles .btn')).toMatch(/min-height:\s*44px/)
    expect(rule(esc!.body, '.platform-toggles .btn')).toMatch(/display:\s*inline-flex/)
  })

  it('spaces the picker and attendee chip rows like every other one', () => {
    // .picker-results and .attendees set gap: 6px at the same specificity ~1900
    // lines later, so the coarse rule has to name them or it loses on order
    const sel = '.platform-toggles, .platform-toggles.picker-results, .platform-toggles.attendees'
    const gaps = coarse.find(b => rule(b.body, sel))
    expect(gaps, 'the coarse .platform-toggles gap must outrank the later .picker-results/.attendees gaps').toBeTruthy()
    expect(rule(gaps!.body, sel)).toMatch(/gap:\s*8px/)
  })

  it('declares the coarse chip rule after the desktop one, since a media query adds no specificity', () => {
    // .mood-chip { padding: 4px 9px } would otherwise win on source order alone
    expect(bare.indexOf('.mood-chip')).toBeLessThan(chipRule!.at)
  })

  it('leaves the desktop pill alone', () => {
    // the 27pt chip and the 6px row gap are outside every media query
    expect(rule(bare, '.mood-chip')).toMatch(/padding:\s*4px 9px/)
    expect(rule(bare, '.toggle')).toMatch(/padding:\s*5px 12px/)
  })

  it('lets the journal textarea grow, with a cap that scrolls instead of running off the card', () => {
    const box = rule(bare, '.journal-editor textarea')
    expect(box).toMatch(/max-height:/)
    expect(box).toMatch(/overflow-y:\s*auto/)
    // WKWebView draws no resize handle, and JS owns the height from here on
    expect(box).toMatch(/resize:\s*none/)
  })

  it('wraps the journal day header so Edit cannot be clipped off the page', () => {
    // .content has overflow-x: clip, so an overflowing header has no scroll to recover
    expect(rule(bare, '.journal-day-head')).toMatch(/flex-wrap:\s*wrap/)
  })
})

/** Where each `@media (max-width: 640px)` block starts, and what it contains. */
function narrowBlocks(): { at: number; body: string }[] {
  return [...bare.matchAll(/@media\s*\(max-width:\s*640px\)/g)].map(m => ({ at: m.index, body: blockBody(m.index) }))
}

describe('phone: the journal look-back is readable', () => {
  const narrow = narrowBlocks()

  it('keeps the whole page scrollable while the mood chart takes the sideways drag', () => {
    // the chart reads clientX to move its readout, since a phone has no hover.
    // `none` would swallow a vertical scroll that merely began on the chart.
    const chart = rule(bare, '.mood-chart')
    expect(chart).toMatch(/touch-action:\s*pan-y/)
    expect(chart).not.toMatch(/touch-action:\s*none/)
    // and pinch-zoom stays with the browser: a dense 150px graphic is the thing
    // a low-vision reader is most likely to want to magnify
    expect(chart).toMatch(/touch-action:\s*pan-y pinch-zoom/)
  })

  it('reserves the readout line so a scrub never moves the chart under the thumb', () => {
    // only where a finger can scrub: an always-reserved strip would be a
    // permanently empty line under the desktop chart, which never scrubs itself
    const floor = coarseBlocks().find(b => rule(b.body, '.mood-readout'))
    expect(floor, 'no @media (pointer: coarse) floor under .mood-readout').toBeTruthy()
    // one line, and two on a phone — in the readout's OWN units, so the
    // reservation follows Dynamic Type. A px floor sized against 0.75rem text
    // stops covering that text the moment --type-scale leaves 1, which is the
    // layout jump the strip exists to prevent.
    expect(rule(floor!.body, '.mood-readout')).toMatch(/min-height:\s*calc\(1\.4 \* 0\.75rem\)/)
    expect(rule(bare, '.mood-readout'), 'the mouse page keeps no empty strip').not.toMatch(/min-height:/)
    const taller = narrow.find(b => rule(b.body, '.mood-readout'))
    expect(taller, 'the phone readout needs room for two lines').toBeTruthy()
    expect(rule(taller!.body, '.mood-readout')).toMatch(/min-height:\s*calc\(2 \* 1\.4 \* 0\.75rem\)/)
    // and the units are the ones the text is actually set in
    expect(rule(bare, '.mood-readout')).toMatch(/font-size:\s*0\.75rem/)
    expect(rule(bare, '.mood-readout')).toMatch(/line-height:\s*1\.4/)
  })

  it('gives the stats disclosure the 44pt floor, since it is the only way to the chart', () => {
    const toggle = coarseBlocks().find(b => rule(b.body, '.journal-stats-toggle'))
    expect(toggle, 'no @media (pointer: coarse) rule for .journal-stats-toggle').toBeTruthy()
    expect(rule(toggle!.body, '.journal-stats-toggle')).toMatch(/min-height:\s*44px/)
  })

  it('sticks the month sub-headers under the top bar, on the phone only', () => {
    const months = narrow.find(b => rule(b.body, '.journal-month-head'))
    expect(months, 'no @media (max-width: 640px) rule for .journal-month-head').toBeTruthy()
    const sticky = rule(months!.body, '.journal-month-head')
    expect(sticky).toMatch(/position:\s*sticky/)
    // clear of the sticky .topbar and the status bar it pads itself for. The
    // height is a token, not a magic number: the phone bar is 61px (its tallest
    // control is the 40px .new-post-btn), not the desktop's 56px.
    expect(sticky).toMatch(/top:\s*calc\(var\(--topbar-h\) \+ env\(safe-area-inset-top\)\)/)
    // desktop keeps a plain label: sticking there is the phone's problem
    expect(rule(bare, '.journal-month-head')).not.toMatch(/position:\s*sticky/)
  })

  it('measures the top bar once, knows it is taller on a phone, and lets it grow with the text', () => {
    // the bar is padding + border (fixed) + its tallest control's text box
    // (scaled), so the token is a calc rather than a number — but it still has
    // to resolve to the measured 56 / 61 at scale 1 or every scroll target moves
    expect(barHeight(rule(bare, ':root'), 1)).toBe(56)
    const phone = narrow.find(b => /--topbar-h/.test(rule(b.body, ':root')))
    expect(phone, 'the phone bar is 5px taller than the desktop one — say so once').toBeTruthy()
    expect(barHeight(rule(phone!.body, ':root'), 1)).toBe(61)
    // and a reader on the largest Dynamic Type gets more clearance, not less
    expect(barHeight(rule(bare, ':root'), 1.6)).toBeGreaterThan(56)
    // The phone bar is floored by a fixed 40px square only while the text is
    // small enough; past scale ≈ 1.18 the 🔍 / ⚙ .btn.subtle pair is taller and
    // the bar grows with them. `>= 61` passed vacuously while the token was
    // pinned at 61 across the whole clamp, so measure the real bar instead:
    // never under it (a heading would sit behind the chrome), and never more
    // than a few px over it (a gap the journal rows would scroll through).
    for (const scale of [0.9, 1, 1.18, 1.3, 1.6]) {
      const token = barHeight(rule(phone!.body, ':root'), scale)
      const real = measuredPhoneBar(scale)
      expect(token, `--topbar-h understates the bar at scale ${scale}`).toBeGreaterThanOrEqual(real)
      expect(token, `--topbar-h overstates the bar at scale ${scale}`).toBeLessThan(real + 4)
    }
  })

  it('clears the sticky month header too when a past day is opened', () => {
    // the day cards scroll under the stuck month label, so the bar's height
    // alone leaves the card's border and padding behind it
    const day = narrow.find(b => rule(b.body, '.journal-day'))
    expect(day, 'no @media (max-width: 640px) scroll margin for .journal-day').toBeTruthy()
    expect(rule(day!.body, '.journal-day')).toMatch(/scroll-margin-top:\s*calc\(var\(--topbar-h\) \+ 24px \+ env\(safe-area-inset-top\)\)/)
    // today's card is the top of the list, with no month header above it
    expect(rule(bare, '.journal-card, .journal-day')).toMatch(/scroll-margin-top:\s*calc\(var\(--topbar-h\) \+ 8px \+ env\(safe-area-inset-top\)\)/)
  })
})

describe("phone: Today's first screen is worth the morning", () => {
  const narrow = narrowBlocks()

  it('hides the two reporting-only tiles below 640px', () => {
    const hidden = narrow.find(b => rule(b.body, '.kpi-extra'))
    expect(hidden, 'no @media (max-width: 640px) rule for .kpi-extra').toBeTruthy()
    expect(rule(hidden!.body, '.kpi-extra')).toMatch(/display:\s*none/)
    // the desktop row keeps all five, sparkline included: the class is declared
    // nowhere but inside that one narrow block
    expect(bare.match(/\.kpi-extra\s*\{/g), 'the desktop page must keep every tile').toHaveLength(1)
  })

  it('spans the surviving odd tile so the 2-up row has no dead cell', () => {
    const wide = narrow.find(b => rule(b.body, '.kpi-row > .kpi-wide'))
    expect(wide, 'no @media (max-width: 640px) rule for .kpi-row > .kpi-wide').toBeTruthy()
    expect(rule(wide!.body, '.kpi-row > .kpi-wide')).toMatch(/grid-column:\s*1 \/ -1/)
    // and the auto-fit desktop row is untouched: the span is declared only there
    expect(bare.match(/\.kpi-wide\s*\{/g)).toHaveLength(1)
  })

  it('clears the sticky top bar when a tile jumps to its section', () => {
    // .topbar is position: sticky and pads itself for the status bar, so an
    // anchored section lands under the chrome without this
    const anchor = rule(bare, '.today-grid > section')
    expect(anchor).toMatch(/scroll-margin-top:\s*calc\(var\(--topbar-h\) \+ 8px \+ env\(safe-area-inset-top\)\)/)
  })

  it('animates the jump on the phone, and stops animating for anyone who asked it to', () => {
    // the desktop keeps its instant jump: the smooth default is phone work
    const smooth = narrow.find(b => /scroll-behavior/.test(rule(b.body, 'html')))
    expect(smooth, 'no @media (max-width: 640px) rule for html').toBeTruthy()
    expect(rule(smooth!.body, 'html')).toMatch(/scroll-behavior:\s*smooth/)
    const reduced = [...bare.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g)].map(m => blockBody(m.index))
    expect(reduced.some(b => /scroll-behavior:\s*auto/.test(rule(b, 'html')))).toBe(true)
  })

  it('gives the bulk defer a full-width 44pt target on a touch screen', () => {
    const bulk = coarseBlocks().find(b => rule(b.body, '.kpi-bulk .btn'))
    expect(bulk, 'no @media (pointer: coarse) rule for .kpi-bulk .btn').toBeTruthy()
    expect(rule(bulk!.body, '.kpi-bulk .btn')).toMatch(/min-height:\s*44px/)
  })

  it('gives each routine step a 44pt row, with the pitch equal to the target', () => {
    // a tick is a synced store write, so a thumb that meant one step must not
    // land on the next: the 18px box and 14px text are a 24px row on a mouse page
    const step = coarseBlocks().find(b => rule(b.body, '.routine-step'))
    expect(step, 'no @media (pointer: coarse) rule for .routine-step').toBeTruthy()
    expect(rule(step!.body, '.routine-step')).toMatch(/min-height:\s*44px/)
    // and no dead strip between rows, or the floor would still leave a gap to miss into
    expect(rule(step!.body, '.routine-steps')).toMatch(/gap:\s*0/)
    // the desktop list keeps its tight 4px pitch
    expect(rule(bare, '.routine-steps')).toMatch(/gap:\s*4px/)
  })

  it('puts the routine name ellipsis on the name, so the when-pill survives a long one', () => {
    // text-overflow on the flex button does nothing to its span child, which
    // keeps its full text width and pushes the flex:none pill out of the box
    expect(rule(bare, '.routine-name')).not.toMatch(/text-overflow/)
    const name = rule(bare, '.routine-name > span:first-child')
    expect(name).toMatch(/min-width:\s*0/)
    expect(name).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule(bare, '.routine-when')).toMatch(/flex:\s*none/)
  })

  it('dresses a jumping tile as the tile it replaces, with no iOS tap flash', () => {
    const jump = rule(bare, '.stat-jump')
    expect(jump).toMatch(/appearance:\s*none/)
    expect(jump).toMatch(/font:\s*inherit/)
    expect(jump).toMatch(/text-align:\s*left/)
    expect(jump).toMatch(/-webkit-tap-highlight-color:\s*transparent/)
  })
})

describe('phone: the grocery list survives a real shop', () => {
  const narrow = narrowBlocks()

  it('splits the three state buttons across the row at a real 44pt each', () => {
    const states = narrow.find(b => rule(b.body, '.grocery-states .seg'))
    expect(states, 'no @media (max-width: 640px) rule for .grocery-states .seg').toBeTruthy()
    const seg = rule(states!.body, '.grocery-states .seg')
    // text-sized chips are what makes Have/Need/Got it a mis-tap; an equal share
    // of the full-width row is ~100px each at 375pt
    expect(seg).toMatch(/flex:\s*1/)
    // the height is not this rule's job — `button.seg` carries the 44px floor
    // for every segment in the app inside the coarse block above
    expect(seg, 'the 44pt floor is the coarse block\u2019s, not a second copy here').not.toMatch(/min-height:/)
  })

  it('reserves the Clear ticked line before the first tick, at a real 44pt', () => {
    const clear = narrow.find(b => rule(b.body, '.grocery-clear'))
    expect(clear, 'no @media (max-width: 640px) rule for .grocery-clear').toBeTruthy()
    expect(rule(clear!.body, '.grocery-clear')).toMatch(/width:\s*100%/)
    // it sweeps every held line off screen, so it is the worst control to leave
    // as a 33px .btn stub
    expect(rule(clear!.body, '.grocery-clear')).toMatch(/min-height:\s*44px/)
    // a full-width button in a wrapping row always takes its own line, so
    // appearing on the first tick would push the list down under the thumb
    // the parent class puts the phone rule a class ahead of the desktop
    // `display: none`, so it wins wherever either one is declared
    const off = rule(clear!.body, '.grocery-filter-row .grocery-clear:disabled')
    expect(off, 'the phone must keep the line whether or not anything is ticked').toMatch(/visibility:\s*hidden/)
    expect(off).not.toMatch(/display:\s*none/)
  })

  it('keeps the desktop row unchanged, with no empty stub beside the segments', () => {
    // the mouse page has nothing to reserve, so an unusable button just goes
    expect(rule(bare, '.grocery-clear:disabled')).toMatch(/display:\s*none/)
    // and the full width and the 44pt floor stay the phone's business: the bare
    // `.grocery-clear` rule is declared inside the narrow block and nowhere else
    expect(bare.match(/\.grocery-clear\s*\{/g)).toHaveLength(1)
  })

  it('leaves the filter segments and the shared .seg base alone', () => {
    // the widening is scoped: a bare `.seg { flex: 1 }` would stretch every
    // segmented control in the app, the four-way grocery filter included
    expect(rule(bare, '.seg'), 'the desktop pill must not grow').not.toMatch(/flex:/)
    for (const b of narrow) expect(rule(b.body, '.seg'), 'no phone-wide .seg override').toBe('')
  })
})

/** Every `@media (prefers-reduced-motion: reduce)` block's body. */
function reducedBlocks(): string[] {
  return [...bare.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g)].map(m => blockBody(m.index))
}

describe('phone: the type ramp follows the system text size', () => {
  // src/native.ts watchTextSize() measures -apple-system-body in the WKWebView
  // and writes 0.9-1.6 here; every browser stays at the default 1.
  it('declares --type-scale, with a default that changes nothing', () => {
    expect(rule(bare, ':root')).toMatch(/--type-scale:\s*1;/)
  })

  it('multiplies the root font-size by it, so every rem in the sheet follows', () => {
    const html = rule(bare, 'html')
    // `rem` inside the root element's own font-size resolves against the
    // property's initial value -- the reader's browser default, 16px unless
    // they changed it -- so this is 16px on a stock browser and still honours
    // a desktop reader who raised that default.
    expect(html).toMatch(/font-size:\s*calc\(1rem \* var\(--type-scale\)\)/)
    // otherwise WKWebView inflates text on its own on top of the scale
    expect(html).toMatch(/-webkit-text-size-adjust:\s*100%/)
  })

  it('carries the scale on the body step too', () => {
    expect(rule(bare, 'body')).toMatch(/font-size:\s*calc\(14px \* var\(--type-scale\)\)/)
  })

  it('converted the ramp to rem rather than leaving it in pixels', () => {
    const sizes = [...bare.matchAll(/font-size:\s*([^;]+);/g)].map(m => m[1].trim())
    const rem = sizes.filter(v => v.endsWith('rem')).length
    // ~130 of the ~165 sizes are prose or control labels; the rest are icons,
    // avatars and chart geometry, which are drawn to fixed boxes on purpose
    expect(rem).toBeGreaterThan(sizes.length * 0.7)
  })

  it('caps the tab bar label, since five of them share one fixed-height bar', () => {
    const compact = narrowBlocks().map(b => rule(b.body, '.tabs-compact .tab')).find(Boolean)
    expect(compact, 'no .tabs-compact .tab rule under @media (max-width: 640px)').toBeTruthy()
    expect(compact).toMatch(/font-size:\s*calc\(10px \* min\(1\.15, var\(--type-scale\)\)\)/)
  })

  it('lets a phone field grow past the anti-zoom floor instead of pinning it', () => {
    // 16px is what stops WKWebView zooming; on large Dynamic Type a field must
    // still be able to match the prose around it, so the guard is a max(), and
    // max(16px, 1rem) is exactly 16px at scale 1
    const guard = css.slice(css.lastIndexOf("[contenteditable='true']"))
    expect(guard).toMatch(/font-size:\s*max\(16px,\s*1rem\)/)
    expect(guard).not.toMatch(/font-size:\s*16px/)
  })
})

describe('phone: Reduce Motion is honoured, not decorated', () => {
  it('resets every animation, transition and smooth scroll', () => {
    const catchAll = reducedBlocks()
      .map(b => rule(b, '*, *::before, *::after'))
      .find(Boolean)
    expect(catchAll, 'no `*, *::before, *::after` reset in a prefers-reduced-motion block').toBeTruthy()
    for (const decl of [
      // 0.01ms rather than 0 so a transitionend/animationend listener still fires
      'animation-duration: 0.01ms !important',
      'animation-iteration-count: 1 !important',
      'transition-duration: 0.01ms !important',
      'scroll-behavior: auto !important',
    ]) {
      expect(catchAll).toContain(decl)
    }
  })

  it('leaves nothing slow enough that losing it would be a surprise', () => {
    // A transition or animation longer than 400ms is a reduced-motion smell:
    // it is long enough that the app reads as a different app without it, which
    // is the state every Reduce Motion reader is in. The first time in each
    // comma-separated part is the duration; a second one is the delay.
    let outside = bare
    for (const b of reducedBlocks()) outside = outside.replace(b, '')
    const slow: string[] = []
    for (const m of outside.matchAll(/(^|[;{\s])(transition|animation)\s*:\s*([^;{}]+);/g)) {
      for (const part of m[3].split(',')) {
        const t = /(-?[\d.]+)(ms|s)\b/.exec(part)
        if (!t) continue
        const ms = Number(t[1]) * (t[2] === 's' ? 1000 : 1)
        if (ms > 400) slow.push(`${m[2]}: ${part.trim()}`)
      }
    }
    expect(slow).toEqual([])
  })
})
