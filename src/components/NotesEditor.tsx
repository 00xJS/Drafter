import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown, wordCount } from '../markdown'
import { useMediaQuery } from '../useMediaQuery'

interface Props {
  value: string
  onChange(next: string): void
  placeholder?: string
  /** Shown in the footer (e.g. "Saved 2s ago"). */
  status?: string
  autoFocus?: boolean
}

const EMOJI = ['💡', '✅', '⭐', '🔥', '❤', '🎯', '📌', '📝', '🏡', '🛠', '💻', '💰', '📅', '⏰', '🚀', '🎉', '🤔', '⚠', '❓', '👍', '👀', '🧠', '🌱', '🍕', '☕', '🎁', '✈', '🏃', '🎨', '🔧']

type Wrap = { before: string; after?: string; block?: boolean; placeholder?: string }

const TOOLS: { label: string; title: string; wrap: Wrap; key?: string }[] = [
  { label: 'B', title: 'Bold (Cmd/Ctrl+B)', wrap: { before: '**', after: '**', placeholder: 'bold' }, key: 'b' },
  { label: 'I', title: 'Italic (Cmd/Ctrl+I)', wrap: { before: '_', after: '_', placeholder: 'italic' }, key: 'i' },
  { label: 'S', title: 'Strikethrough', wrap: { before: '~~', after: '~~', placeholder: 'done' } },
  { label: 'H', title: 'Heading', wrap: { before: '## ', block: true, placeholder: 'Heading' } },
  { label: '•', title: 'Bullet list', wrap: { before: '- ', block: true, placeholder: 'item' } },
  { label: '1.', title: 'Numbered list', wrap: { before: '1. ', block: true, placeholder: 'first' } },
  { label: '☐', title: 'Checklist', wrap: { before: '- [ ] ', block: true, placeholder: 'to do' } },
  { label: '“', title: 'Quote', wrap: { before: '> ', block: true, placeholder: 'quote' } },
  { label: '<>', title: 'Inline code', wrap: { before: '`', after: '`', placeholder: 'code' } },
  { label: '{ }', title: 'Code block', wrap: { before: '```\n', after: '\n```', block: true, placeholder: 'code' } },
  { label: '🔗', title: 'Link (Cmd/Ctrl+K)', wrap: { before: '[', after: '](https://)', placeholder: 'text' }, key: 'k' },
  { label: '―', title: 'Divider', wrap: { before: '\n---\n', block: true } },
]

/**
 * A Markdown notes pad with a formatting toolbar, emoji picker, keyboard
 * shortcuts and live preview (side by side on desktop, toggled on mobile).
 */
export function NotesEditor({ value, onChange, placeholder, status, autoFocus }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const narrow = useMediaQuery('(max-width: 900px)')
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const html = useMemo(() => renderMarkdown(value), [value])

  useEffect(() => {
    if (autoFocus) ta.current?.focus()
  }, [autoFocus])

  /** Insert text around the selection (or at the caret), keeping focus. */
  function apply(w: Wrap) {
    const el = ta.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = value.slice(start, end)
    let before = w.before
    if (w.block && start > 0 && value[start - 1] !== '\n') before = '\n' + before
    const body = selected || w.placeholder || ''
    const after = w.after ?? ''
    const next = value.slice(0, start) + before + body + after + value.slice(end)
    onChange(next)
    const selStart = start + before.length
    const selEnd = selStart + body.length
    requestAnimationFrame(() => {
      el.focus()
      if (w.after === '](https://)') el.setSelectionRange(selEnd + 2, selEnd + 2 + 'https://'.length)
      else el.setSelectionRange(selected ? selEnd : selStart, selEnd)
    })
  }

  function insert(text: string) {
    apply({ before: text, after: '' })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.metaKey || e.ctrlKey) {
      const tool = TOOLS.find(t => t.key === e.key.toLowerCase())
      if (tool) {
        e.preventDefault()
        apply(tool.wrap)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // continue lists and checklists on Enter
      const el = e.currentTarget
      const pos = el.selectionStart
      const lineStart = value.lastIndexOf('\n', pos - 1) + 1
      const line = value.slice(lineStart, pos)
      const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/)
      if (m) {
        e.preventDefault()
        if (!m[4].trim()) {
          onChange(value.slice(0, lineStart) + value.slice(pos)) // empty item ends the list
          requestAnimationFrame(() => el.setSelectionRange(lineStart, lineStart))
          return
        }
        const marker = /\d/.test(m[2]) ? `${parseInt(m[2], 10) + 1}. ` : `${m[2]} `
        const prefix = `\n${m[1]}${marker}${m[3] ? '[ ] ' : ''}`
        onChange(value.slice(0, pos) + prefix + value.slice(pos))
        requestAnimationFrame(() => el.setSelectionRange(pos + prefix.length, pos + prefix.length))
      }
    }
  }

  const showEditor = !narrow || mode === 'write'
  const showPreview = !narrow || mode === 'preview'

  return (
    <div className="notes">
      <div className="notes-toolbar">
        {TOOLS.map(t => (
          <button key={t.title} type="button" className="btn subtle notes-tool" title={t.title} onMouseDown={e => e.preventDefault()} onClick={() => apply(t.wrap)}>
            {t.label}
          </button>
        ))}
        <span className="notes-emoji-wrap">
          <button
            type="button"
            className="btn subtle notes-tool"
            title="Emoji (the system picker also works: Ctrl+Cmd+Space on Mac, Win+. on Windows)"
            onMouseDown={e => e.preventDefault()}
            onClick={() => setEmojiOpen(o => !o)}
          >
            😀
          </button>
          {emojiOpen && (
            <span className="notes-emoji" onMouseDown={e => e.preventDefault()}>
              {EMOJI.map(e => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    insert(e + ' ')
                    setEmojiOpen(false)
                  }}
                >
                  {e}
                </button>
              ))}
            </span>
          )}
        </span>
        <span className="spacer" />
        {narrow && (
          <span className="segmented">
            <button type="button" className={mode === 'write' ? 'seg on' : 'seg'} onClick={() => setMode('write')}>
              Write
            </button>
            <button type="button" className={mode === 'preview' ? 'seg on' : 'seg'} onClick={() => setMode('preview')}>
              Preview
            </button>
          </span>
        )}
      </div>
      <div className={narrow ? 'notes-body' : 'notes-body split'}>
        {showEditor && (
          <textarea
            ref={ta}
            className="notes-input"
            value={value}
            placeholder={placeholder ?? 'Brainstorm here. **bold**, _italic_, `code`, ```code blocks```, [links](https://...), - lists, - [ ] checklists, # headings...'}
            onChange={e => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck
          />
        )}
        {showPreview && (
          <div className="notes-preview md" dangerouslySetInnerHTML={{ __html: html || '<p class="muted">Nothing yet. Start typing on the left.</p>' }} />
        )}
      </div>
      <div className="notes-foot">
        <small>{wordCount(value)} words · Markdown</small>
        <span className="spacer" />
        {status && <small>{status}</small>}
      </div>
    </div>
  )
}
