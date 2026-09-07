// Rich-text notes are stored as a small, sanitized HTML subset. Everything
// that goes into the store passes through sanitizeHtml, and everything that
// comes out of it does too, so a stray script or style can never run.

const ALLOWED: Record<string, string[]> = {
  p: [],
  br: [],
  div: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  del: [],
  code: [],
  pre: [],
  h1: [],
  h2: [],
  h3: [],
  ul: ['class'],
  ol: [],
  li: [],
  blockquote: [],
  hr: [],
  a: ['href'],
  img: ['data-media', 'alt'],
  input: ['type', 'checked'],
}

const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr'])

function safeHref(url: string): string | null {
  const u = url.trim()
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null
}

/** Reduce arbitrary HTML to the allowed subset. Runs in the browser (uses DOMParser). */
export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove()
        continue
      }
      const el = child as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
        el.remove()
        continue
      }
      walk(el)
      if (!(tag in ALLOWED)) {
        // unwrap unknown tags (span, font, table…) keeping their content; block-ish ones become paragraphs
        const replacement = /^(section|article|header|footer|table|tr|td|th|tbody|thead)$/.test(tag) ? doc.createElement('p') : null
        if (replacement) {
          while (el.firstChild) replacement.appendChild(el.firstChild)
          el.replaceWith(replacement)
        } else {
          el.replaceWith(...Array.from(el.childNodes))
        }
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        if (!ALLOWED[tag].includes(attr.name)) el.removeAttribute(attr.name)
      }
      if (tag === 'a') {
        const href = safeHref(el.getAttribute('href') ?? '')
        if (!href) el.replaceWith(...Array.from(el.childNodes))
        else {
          el.setAttribute('href', href)
          el.setAttribute('target', '_blank')
          el.setAttribute('rel', 'noreferrer noopener')
        }
      } else if (tag === 'img') {
        if (!el.getAttribute('data-media')) el.remove()
      } else if (tag === 'input') {
        if (el.getAttribute('type') !== 'checkbox') el.remove()
      } else if (tag === 'ul' && el.getAttribute('class') && el.getAttribute('class') !== 'checklist') {
        el.removeAttribute('class')
      }
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

/** Plain text of a note, for previews, word counts and agents. */
export function htmlToText(html: string): string {
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/g, ' ')
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const parts: string[] = []
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent ?? '')
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = (child as HTMLElement).tagName.toLowerCase()
        if (tag === 'img') parts.push(' [photo] ')
        else if (tag === 'input') parts.push((child as HTMLElement).hasAttribute('checked') ? '[x] ' : '[ ] ')
        else {
          visit(child)
          if (BLOCKS.has(tag) || tag === 'br') parts.push('\n')
        }
      }
    }
  }
  visit(doc.body)
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function wordCountHtml(html: string): number {
  return (htmlToText(html).match(/\S+/g) ?? []).length
}

/** Ids of every inline photo in a note. */
export function mediaIdsIn(html: string): string[] {
  return Array.from(html.matchAll(/data-media="([^"]+)"/g), m => m[1])
}
