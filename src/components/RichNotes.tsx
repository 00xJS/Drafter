import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { imageFiles, mediaURL } from '../media'
import { savePicture } from '../picture'
import { openExternal } from '../native'
import { sanitizeHtml, wordCountHtml, wordCountOf } from '../richtext'
import { Icon } from './Icon'
import { tipAttrs } from './notes/tips'

interface Props {
  /** Sanitized HTML. */
  value: string
  onChange(next: string): void
  status?: string
  autoFocus?: boolean
  /** Turn the selected text (or the current line) into a task. */
  onCreateTask?(title: string): void
}

const EMOJI = ['💡', '✅', '⭐', '🔥', '❤', '🎯', '📌', '📝', '🏡', '🛠', '💻', '💰', '📅', '⏰', '🚀', '🎉', '🤔', '⚠', '❓', '👍', '👀', '🧠', '🌱', '🍕', '☕', '🎁', '✈', '🏃', '🎨', '🔧']

/**
 * A button on the bar: what it shows, and what it does in words — its tooltip,
 * aria-label and title (tipAttrs). Every face is one each system draws clearly
 * at this size: the checklist and the photo picker are icons in the text's
 * colour, since the ballot box U+2610 drew as an empty square that read as a
 * glyph the font was missing, and the camera emoji as a dark block on the bar.
 */
type Cmd = { face: ReactNode; tip: string; does: CmdAction; key?: string }
/** What a button does to the page: a browser editing command, HTML at the caret, the selection wrapped, or a link asked for. */
type CmdAction = { exec: string; arg?: string } | { html: string } | { wrap: readonly [string, string] } | 'link'

const TOOLS: Cmd[] = [
  { face: <b>B</b>, tip: 'Bold (Cmd/Ctrl+B)', does: { exec: 'bold' }, key: 'b' },
  { face: <i>I</i>, tip: 'Italic (Cmd/Ctrl+I)', does: { exec: 'italic' }, key: 'i' },
  { face: <u>U</u>, tip: 'Underline (Cmd/Ctrl+U)', does: { exec: 'underline' }, key: 'u' },
  { face: <s>S</s>, tip: 'Strikethrough: cross the text out', does: { exec: 'strikeThrough' } },
  { face: 'H', tip: 'Heading', does: { exec: 'formatBlock', arg: 'H2' } },
  { face: '¶', tip: 'Normal text: undo a heading, quote or code block', does: { exec: 'formatBlock', arg: 'P' } },
  { face: '•', tip: 'Bulleted list', does: { exec: 'insertUnorderedList' } },
  { face: '1.', tip: 'Numbered list', does: { exec: 'insertOrderedList' } },
  { face: <Icon name="checkbox" size={15} strokeWidth={2} />, tip: 'Checklist: a list with tick boxes', does: { html: '<ul class="checklist"><li><input type="checkbox"> </li></ul>' } },
  { face: '“', tip: 'Quote: set a paragraph apart', does: { exec: 'formatBlock', arg: 'BLOCKQUOTE' } },
  { face: '<>', tip: 'Code: monospace text within a line', does: { wrap: ['<code>', '</code>'] } },
  { face: '{ }', tip: 'Code block: lines of monospace text', does: { exec: 'formatBlock', arg: 'PRE' } },
  { face: '🔗', tip: 'Link (Cmd/Ctrl+K)', does: 'link', key: 'k' },
  { face: '―', tip: 'Divider: a line across the note', does: { exec: 'insertHorizontalRule' } },
]

// ---- opening a link --------------------------------------------------------
//
// The pad is always editable, so a tap on a link places the caret, as it
// should — and on a phone that was the end of it: links opened only on
// Cmd/Ctrl+click, which a phone has no way to make. A tap that lands on a
// link with nothing selected now offers an Open ↗ beside it.

/** What a tap in the text asks for: a link to offer, a link to open now (Cmd/Ctrl+click), or nothing. */
export type LinkTap = { href: string; open: boolean } | null

/**
 * Read one tap. `target` is where it landed; `collapsed` whether the
 * selection is just a caret. A selection is left alone: that is editing the
 * link's words, not following it. Only the links the sanitizer keeps count.
 */
export function readLinkTap(target: EventTarget | null, keys: { metaKey: boolean; ctrlKey: boolean }, collapsed: boolean): LinkTap {
  const link = (target as Element | null)?.closest?.('a[href]')
  const href = link?.getAttribute('href') ?? ''
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return null
  if (keys.metaKey || keys.ctrlKey) return { href, open: true }
  return collapsed ? { href, open: false } : null
}

/** About how wide the Open ↗ button draws, so it is never placed off the pad's right edge. */
const LINK_TIP_WIDTH = 96

/** Where the Open ↗ goes, against the pad: just under the link, inside the pad's width; null once the link has scrolled out of the text's view. */
export function linkTipPlace(link: DOMRectReadOnly, pad: DOMRectReadOnly, view: DOMRectReadOnly, width = LINK_TIP_WIDTH): { top: number; left: number } | null {
  if (link.bottom <= view.top || link.top >= view.bottom) return null
  return { top: Math.round(link.bottom - pad.top + 4), left: Math.round(Math.max(0, Math.min(link.left - pad.left, pad.width - width))) }
}

/** Where the Open ↗ for `link` sits now in `pad`; null when there is nothing on screen to point at. */
function tipAt(link: Element, pad: HTMLElement | null, text: HTMLElement | null): { top: number; left: number } | null {
  const padBox = pad?.getBoundingClientRect()
  const textBox = text?.getBoundingClientRect()
  return padBox && textBox && link.isConnected ? linkTipPlace(link.getBoundingClientRect(), padBox, textBox) : null
}

/** Open a note's link where it belongs: a web page in Safari's sheet (a new tab on the web), an address in the mail app. */
export function openNoteLink(href: string): void {
  if (/^mailto:/i.test(href)) window.location.href = href
  else void openExternal(href)
}

/**
 * How long typing rests before the note is written out. Every key used to
 * copy the whole note, sanitize it (a DOMParser) and hand it up, and the
 * re-render then parsed it again to count its words: twice per key. A burst
 * of typing is written out and counted once now, a beat after the last key —
 * and at once on a toolbar action, a blur, the page hiding, the pad closing
 * and an edit arriving from elsewhere, so no key is lost to the wait.
 */
export const EMIT_AFTER_MS = 250

/**
 * One running notepad: type straight into the page, format with the toolbar
 * or shortcuts, paste or drop photos inline. The HTML is sanitized on the way
 * in and out; photos live in the media store (synced) and are referenced by id.
 */
export function RichNotes({ value, onChange, status, autoFocus, onCreateTask }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const pad = useRef<HTMLDivElement>(null)
  const tipButton = useRef<HTMLButtonElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  /** The link a tap landed on while its Open ↗ is offered, and where that sits in the pad. */
  const [linkTip, setLinkTip] = useState<{ link: Element; href: string; top: number; left: number } | null>(null)
  const lastEmitted = useRef(value)
  /** The footer's count, taken from the pad's own text whenever the note is written out or taken in. */
  const [words, setWords] = useState(() => wordCountHtml(value))
  /** Typing not yet written out, and the timer that will. */
  const typed = useRef(false)
  const emitTimer = useRef<number | undefined>(undefined)
  // the newest handler, for a write the timer makes after the parent has drawn again
  const changed = useRef(onChange)
  useLayoutEffect(() => {
    changed.current = onChange
  })

  /** Keep the Open ↗ under its link as the text scrolls or the page resizes (the keyboard coming up). */
  const followTip = useCallback(
    () =>
      setLinkTip(tip => {
        const at = tip && tipAt(tip.link, pad.current, box.current)
        return tip && at ? { ...tip, ...at } : null
      }),
    [],
  )

  // a tap anywhere but the text or the Open ↗ itself puts the Open ↗ away
  const tipShowing = linkTip !== null
  useEffect(() => {
    if (!tipShowing) return
    const away = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (box.current?.contains(t) || tipButton.current?.contains(t))) return
      setLinkTip(null)
    }
    document.addEventListener('pointerdown', away)
    window.addEventListener('resize', followTip)
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('resize', followTip)
    }
  }, [tipShowing, followTip])

  /** Serialize the editable (photos keep only their media id, never a blob URL), count its words, and hand it up if it changed. */
  const write = useCallback((el: HTMLElement | null) => {
    window.clearTimeout(emitTimer.current)
    typed.current = false
    if (!el) return
    const clone = el.cloneNode(true) as HTMLElement
    for (const img of Array.from(clone.querySelectorAll('img'))) img.removeAttribute('src')
    for (const cb of Array.from(clone.querySelectorAll('input[type=checkbox]'))) {
      const input = cb as HTMLInputElement
      if (input.checked) input.setAttribute('checked', '')
      else input.removeAttribute('checked')
    }
    const html = sanitizeHtml(clone.innerHTML)
    // off the copy, whose tick boxes say whether they are ticked, as the saved note's do
    setWords(wordCountOf(clone))
    if (html !== lastEmitted.current) {
      lastEmitted.current = html
      changed.current(html)
    }
  }, [])
  /** Write the note out now: a toolbar action, a blur, and anything that must not wait on typing. */
  const emit = useCallback(() => write(box.current), [write])
  /** Typing: written out a beat after the last key. */
  const emitSoon = () => {
    typed.current = true
    window.clearTimeout(emitTimer.current)
    emitTimer.current = window.setTimeout(emit, EMIT_AFTER_MS)
  }

  // The pad closing writes out what was typed a moment ago. A layout
  // cleanup: it runs while the pad is still on the page, and before any
  // screen's own save as it closes (theirs are effects, which run after).
  useLayoutEffect(() => {
    const el = box.current
    return () => {
      if (typed.current) write(el)
    }
  }, [write])
  // …and the page going into the background, before the screen's save on the
  // same event: the pad's listener is added first, as a child's effects run
  // before its parent's
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden' && typed.current) emit()
    }
    const leave = () => {
      if (typed.current) emit()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
    }
  }, [emit])

  /** Give every photo a displayable src from the media store. */
  const hydrateImages = useCallback(async () => {
    const el = box.current
    if (!el) return
    for (const img of Array.from(el.querySelectorAll('img[data-media]'))) {
      if (img.getAttribute('src')) continue
      const url = await mediaURL(img.getAttribute('data-media')!)
      if (url) img.setAttribute('src', url)
      else img.setAttribute('alt', 'photo not available offline')
    }
  }, [])

  // load external changes (initial value, or an edit from another device)
  useEffect(() => {
    const el = box.current
    if (!el || value === lastEmitted.current) return
    // typing not yet written out is written out instead, and wins, as it did
    // when every key was written at once: the screen had not taken the other
    // copy over words it knew were being typed
    if (typed.current) {
      write(el)
      return
    }
    el.innerHTML = sanitizeHtml(value)
    lastEmitted.current = value
    setWords(wordCountOf(el))
    hydrateImages()
  }, [value, hydrateImages, write])

  // The page as it opens: the value it opened on, focused if asked. Once, as
  // the pad mounts — a later value arrives through the effect above, and a
  // later autoFocus must not pull the caret away from where it is.
  const fill = useEffectEvent(() => {
    const el = box.current
    if (!el) return
    el.innerHTML = sanitizeHtml(value)
    lastEmitted.current = value
    setWords(wordCountOf(el))
    hydrateImages()
    if (autoFocus) el.focus()
  })
  useEffect(() => {
    fill()
  }, [])

  const exec = (command: string, arg?: string) => {
    box.current?.focus()
    document.execCommand(command, false, arg)
    emit()
  }

  const insertHtml = (html: string) => {
    box.current?.focus()
    document.execCommand('insertHTML', false, html)
    emit()
  }

  const wrapSelection = (before: string, after: string) => {
    const sel = window.getSelection()
    const text = sel?.toString() ?? ''
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    insertHtml(`${before}${esc(text || 'code')}${after}`)
  }

  const addLink = () => {
    const sel = window.getSelection()
    const text = sel?.toString() ?? ''
    const url = window.prompt('Link address (https://…)', 'https://')
    if (!url || !/^(https?:\/\/|mailto:)/i.test(url.trim())) return
    if (text) exec('createLink', url.trim())
    else insertHtml(`<a href="${url.trim()}">${url.trim()}</a>`)
  }

  async function addFiles(files: FileList | File[]) {
    const list = imageFiles(files)
    if (list.length === 0) return
    box.current?.focus()
    for (const file of list) {
      // at the size the app keeps a picture, not the camera's full photo
      const id = await savePicture(file)
      const url = await mediaURL(id)
      insertHtml(`<p><img data-media="${id}" src="${url ?? ''}" alt="${file.name.replace(/"/g, '')}"></p>`)
    }
  }

  const run = (does: CmdAction) => {
    if (does === 'link') addLink()
    else if ('exec' in does) exec(does.exec, does.arg)
    else if ('html' in does) insertHtml(does.html)
    else wrapSelection(...does.wrap)
  }

  return (
    <div ref={pad} className={dragging ? 'notes dragging' : 'notes'}>
      <div className="notes-toolbar">
        {TOOLS.map(t => (
          <button key={t.tip} type="button" className="btn subtle notes-tool" {...tipAttrs(t.tip)} onMouseDown={e => e.preventDefault()} onClick={() => run(t.does)}>
            {t.face}
          </button>
        ))}
        <span className="notes-emoji-wrap">
          <button type="button" className="btn subtle notes-tool" {...tipAttrs('Emoji')} onMouseDown={e => e.preventDefault()} onClick={() => setEmojiOpen(o => !o)}>
            😀
          </button>
          {emojiOpen && (
            <span className="notes-emoji" onMouseDown={e => e.preventDefault()}>
              {EMOJI.map(e => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    exec('insertText', e + ' ')
                    setEmojiOpen(false)
                  }}
                >
                  {e}
                </button>
              ))}
            </span>
          )}
        </span>
        {onCreateTask && (
          <button
            type="button"
            className="btn subtle notes-tool notes-to-task"
            {...tipAttrs('Turn the selected line into a task')}
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              const sel = window.getSelection()
              let text = sel?.toString().trim() ?? ''
              if (!text && sel?.anchorNode) {
                const node = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : (sel.anchorNode as HTMLElement)
                text = node?.closest('li, p, h1, h2, h3')?.textContent?.trim() ?? ''
              }
              if (!text) {
                text = window.prompt('Task title') ?? ''
              }
              if (text.trim()) onCreateTask(text.trim().slice(0, 140))
            }}
          >
            <Icon name="plus" size={13} strokeWidth={2.25} /> Task
          </button>
        )}
        {/* a real button, so the photo picker can be reached and named from the
            keyboard as the other tools are; it opens the hidden file input */}
        <button type="button" className="btn subtle notes-tool" {...tipAttrs('Add photos (or paste or drop them in)')} onMouseDown={e => e.preventDefault()} onClick={() => photoInput.current?.click()}>
          <Icon name="camera" size={15} strokeWidth={2} />
        </button>
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={e => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      <div
        ref={box}
        className="notes-editable md"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-placeholder="Start typing. Paste or drop photos right here. Bold, lists, checklists, links, code and emoji from the bar above."
        onInput={() => {
          // writing moves on from the link that was tapped
          setLinkTip(null)
          emitSoon()
        }}
        onBlur={emit}
        onScroll={() => tipShowing && followTip()}
        onKeyDown={e => {
          setLinkTip(null)
          if (e.metaKey || e.ctrlKey) {
            const tool = TOOLS.find(t => t.key === e.key.toLowerCase())
            if (tool && tool.key === 'k') {
              e.preventDefault()
              run(tool.does)
            }
          }
        }}
        onClick={e => {
          const t = e.target as HTMLElement
          if (t instanceof HTMLInputElement && t.type === 'checkbox') {
            // let the checkbox toggle inside the editable, then persist it
            window.setTimeout(emit, 0)
            return
          }
          const tap = readLinkTap(t, e, window.getSelection()?.isCollapsed ?? true)
          if (!tap) return setLinkTip(null)
          if (tap.open) {
            setLinkTip(null)
            return openNoteLink(tap.href)
          }
          const link = t.closest('a[href]')!
          const at = tipAt(link, pad.current, box.current)
          setLinkTip(at && { link, href: tap.href, ...at })
        }}
        onPaste={e => {
          const files = Array.from(e.clipboardData.files)
          if (files.length > 0) {
            e.preventDefault()
            addFiles(files)
            return
          }
          // paste as clean text/HTML, never with the source page's styles
          const html = e.clipboardData.getData('text/html')
          const text = e.clipboardData.getData('text/plain')
          e.preventDefault()
          if (html) insertHtml(sanitizeHtml(html))
          else insertHtml(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'))
        }}
        onDragOver={e => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          setDragging(false)
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault()
            addFiles(e.dataTransfer.files)
          }
        }}
      />
      {linkTip && (
        <button
          ref={tipButton}
          type="button"
          className="btn notes-link-tip"
          style={{ top: linkTip.top, left: linkTip.left }}
          aria-label={`Open ${linkTip.href}`}
          // the caret stays where the tap put it
          onMouseDown={e => e.preventDefault()}
          onClick={() => {
            openNoteLink(linkTip.href)
            setLinkTip(null)
          }}
        >
          Open ↗
        </button>
      )}
      <div className="notes-foot">
        <small>{words} words · Tap a link to open it</small>
        <span className="spacer" />
        {status && <small>{status}</small>}
      </div>
    </div>
  )
}
