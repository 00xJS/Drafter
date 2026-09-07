import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../markdown'

describe('renderMarkdown', () => {
  it('renders inline formatting and safe links', () => {
    const html = renderMarkdown('**bold** _it_ `code` [site](https://a.b) ~~gone~~ 🎉')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>it</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<a href="https://a.b" target="_blank" rel="noreferrer noopener">site</a>')
    expect(html).toContain('<del>gone</del>')
    expect(html).toContain('🎉')
  })

  it('escapes html and refuses javascript: links', () => {
    const html = renderMarkdown('<script>x</script> [bad](javascript:alert(1))')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('bad')
  })

  it('leaves markdown inside code spans alone', () => {
    expect(renderMarkdown('use `**not bold**` here')).toBe('<p>use <code>**not bold**</code> here</p>')
  })

  it('renders headings, lists, checklists, quotes and code blocks', () => {
    const html = renderMarkdown('# Plan\n- one\n- [x] done\n1. first\n> note\n```js\nlet a = 1 < 2\n```')
    expect(html).toContain('<h1>Plan</h1>')
    expect(html).toContain('<ul><li>one</li><li><input type="checkbox" disabled checked> done</li></ul>')
    expect(html).toContain('<ol><li>first</li></ol>')
    expect(html).toContain('<blockquote><p>note</p></blockquote>')
    expect(html).toContain('<pre><code class="lang-js">let a = 1 &lt; 2</code></pre>')
  })

  it('keeps line breaks inside a paragraph', () => {
    expect(renderMarkdown('a\nb')).toBe('<p>a<br>b</p>')
  })
})
