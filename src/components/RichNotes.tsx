import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaURL, saveMedia } from '../media'
import { sanitizeHtml, wordCountHtml } from '../richtext'

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

type Cmd = { label: string; title: string; run: () => void; key?: string }

/**
 * One running notepad: type straight into the page, format with the toolbar
 * or shortcuts, paste or drop photos inline. The HTML is sanitized on the way
 * in and out; photos live in the media store (synced) and are referenced by id.
 */
export function RichNotes({ value, onChange, status, autoFocus, onCreateTask }: Props) {
  const box = useRef<HTMLDivElement>(null)
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
    { label: 'B', title: 'Bold (Cmd/Ctrl+B)', run: () => exec('bold'), key: 'b' },
    { label: 'I', title: 'Italic (Cmd/Ctrl+I)', run: () => exec('italic'), key: 'i' },
    { label: 'U', title: 'Underline (Cmd/Ctrl+U)', run: () => exec('underline'), key: 'u' },
    { label: 'S', title: 'Strikethrough', run: () => exec('strikeThrough') },
    { label: 'H', title: 'Heading', run: () => exec('formatBlock', 'H2') },
    { label: '¶', title: 'Normal text', run: () => exec('formatBlock', 'P') },
    { label: '•', title: 'Bullet list', run: () => exec('insertUnorderedList') },
    { label: '1.', title: 'Numbered list', run: () => exec('insertOrderedList') },
    { label: '☐', title: 'Checklist', run: () => insertHtml('<ul class="checklist"><li><input type="checkbox"> </li></ul>') },
    { label: '“', title: 'Quote', run: () => exec('formatBlock', 'BLOCKQUOTE') },
    { label: '<>', title: 'Inline code', run: () => wrapSelection('<code>', '</code>') },
    { label: '{ }', title: 'Code block', run: () => exec('formatBlock', 'PRE') },
    { label: '🔗', title: 'Link (Cmd/Ctrl+K)', run: addLink, key: 'k' },
    { label: '―', title: 'Divider', run: () => exec('insertHorizontalRule') },
  ]

  return (
    <div className={dragging ? 'notes dragging' : 'notes'}>
      <div className="notes-toolbar">
        {TOOLS.map(t => (
          <button key={t.title} type="button" className="btn subtle notes-tool" title={t.title} onMouseDown={e => e.preventDefault()} onClick={t.run}>
            {t.label}
          </button>
        ))}
        <span className="notes-emoji-wrap">
          <button type="button" className="btn subtle notes-tool" title="Emoji (Ctrl+Cmd+Space / Win+. also works)" onMouseDown={e => e.preventDefault()} onClick={() => setEmojiOpen(o => !o)}>
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
            title="Turn the selected text (or the line you're on) into a task"
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
            ☐ Task
          </button>
        )}
        <label className="btn subtle notes-tool" title="Add photos (or paste / drop them anywhere in the note)">
          📷
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={e => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
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
