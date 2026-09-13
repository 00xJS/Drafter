import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { mediaURL, saveMedia } from '../media'
import { sanitizeHtml, wordCountHtml } from '../richtext'
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
type Cmd = { face: ReactNode; tip: string; run: () => void; key?: string }

/**
 * One running notepad: type straight into the page, format with the toolbar
 * or shortcuts, paste or drop photos inline. The HTML is sanitized on the way
 * in and out; photos live in the media store (synced) and are referenced by id.
 */
export function RichNotes({ value, onChange, status, autoFocus, onCreateTask }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const lastEmitted = useRef(value)

  /** Serialize the editable (photos keep only their media id, never a blob URL). */
  const emit = useCallback(() => {
    const el = box.current
    if (!el) return
    const clone = el.cloneNode(true) as HTMLElement
    for (const img of Array.from(clone.querySelectorAll('img'))) img.removeAttribute('src')
    for (const cb of Array.from(clone.querySelectorAll('input[type=checkbox]'))) {
      const input = cb as HTMLInputElement
      if (input.checked) input.setAttribute('checked', '')
      else input.removeAttribute('checked')
    }
    const html = sanitizeHtml(clone.innerHTML)
    if (html !== lastEmitted.current) {
      lastEmitted.current = html
      onChange(html)
    }
  }, [onChange])

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
    el.innerHTML = sanitizeHtml(value)
    lastEmitted.current = value
    hydrateImages()
  }, [value, hydrateImages])

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.innerHTML = sanitizeHtml(value)
    lastEmitted.current = value
    hydrateImages()
    if (autoFocus) el.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const list = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (list.length === 0) return
    box.current?.focus()
    for (const file of list) {
      const id = await saveMedia(file)
      const url = await mediaURL(id)
      insertHtml(`<p><img data-media="${id}" src="${url ?? ''}" alt="${file.name.replace(/"/g, '')}"></p>`)
    }
  }

  const TOOLS: Cmd[] = [
    { face: <b>B</b>, tip: 'Bold (Cmd/Ctrl+B)', run: () => exec('bold'), key: 'b' },
    { face: <i>I</i>, tip: 'Italic (Cmd/Ctrl+I)', run: () => exec('italic'), key: 'i' },
    { face: <u>U</u>, tip: 'Underline (Cmd/Ctrl+U)', run: () => exec('underline'), key: 'u' },
    { face: <s>S</s>, tip: 'Strikethrough: cross the text out', run: () => exec('strikeThrough') },
    { face: 'H', tip: 'Heading', run: () => exec('formatBlock', 'H2') },
    { face: '¶', tip: 'Normal text: undo a heading, quote or code block', run: () => exec('formatBlock', 'P') },
    { face: '•', tip: 'Bulleted list', run: () => exec('insertUnorderedList') },
    { face: '1.', tip: 'Numbered list', run: () => exec('insertOrderedList') },
    { face: <Icon name="checkbox" size={15} strokeWidth={2} />, tip: 'Checklist: a list with tick boxes', run: () => insertHtml('<ul class="checklist"><li><input type="checkbox"> </li></ul>') },
    { face: '“', tip: 'Quote: set a paragraph apart', run: () => exec('formatBlock', 'BLOCKQUOTE') },
    { face: '<>', tip: 'Code: monospace text within a line', run: () => wrapSelection('<code>', '</code>') },
    { face: '{ }', tip: 'Code block: lines of monospace text', run: () => exec('formatBlock', 'PRE') },
    { face: '🔗', tip: 'Link (Cmd/Ctrl+K)', run: addLink, key: 'k' },
    { face: '―', tip: 'Divider: a line across the note', run: () => exec('insertHorizontalRule') },
  ]

  return (
    <div className={dragging ? 'notes dragging' : 'notes'}>
      <div className="notes-toolbar">
        {TOOLS.map(t => (
          <button key={t.tip} type="button" className="btn subtle notes-tool" {...tipAttrs(t.tip)} onMouseDown={e => e.preventDefault()} onClick={t.run}>
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
        onInput={emit}
        onBlur={emit}
        onKeyDown={e => {
          if (e.metaKey || e.ctrlKey) {
            const tool = TOOLS.find(t => t.key === e.key.toLowerCase())
            if (tool && tool.key === 'k') {
              e.preventDefault()
              tool.run()
            }
          }
        }}
        onClick={e => {
          const t = e.target as HTMLElement
          if (t instanceof HTMLInputElement && t.type === 'checkbox') {
            // let the checkbox toggle inside the editable, then persist it
            window.setTimeout(emit, 0)
          } else if (t instanceof HTMLAnchorElement && (e.metaKey || e.ctrlKey)) {
            window.open(t.href, '_blank', 'noreferrer')
          }
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
      <div className="notes-foot">
        <small>{wordCountHtml(value)} words · Cmd/Ctrl+click a link to open it</small>
        <span className="spacer" />
        {status && <small>{status}</small>}
      </div>
    </div>
  )
}
