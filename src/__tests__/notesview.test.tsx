import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NotesView } from '../components/NotesView'
import { Project } from '../types'

const T0 = '2026-09-12T09:00:00.000Z'

function project(id: string, over: Partial<Project> = {}): Project {
  return { kind: 'project', id, name: id, color: '#f97316', status: 'active', createdAt: T0, updatedAt: T0, ...over }
}

const PROJECTS = [
  project('p-hall', { name: 'Hall', emoji: '🏡', notesHtml: '<h2>Paint</h2><p>Sage for the hall</p><p><img data-media="m1" alt="swatch"></p>' }),
  project('p-legacy', { name: 'Garden', notes: '# Beds\n- tomatoes' }),
  project('p-empty', { name: 'Garage' }),
  project('p-archived', { name: 'Old', status: 'archived', notesHtml: '<p>kept</p>' }),
]

const noop = () => {}
const legacy = { getLatest: () => undefined, onSave: noop, onSelectProject: noop, onBack: noop, onNewProject: noop, onCreateTask: noop }

describe('NotesView without the new props (the shell as it is today)', () => {
  it('renders the index of project pads exactly as before', () => {
    expect(renderToStaticMarkup(<NotesView projects={PROJECTS} {...legacy} />)).toMatchInlineSnapshot(`"<div class="notes-index"><div class="toolbar"><h2 class="view-title">Notes</h2><span class="cal-hint">Pick a project to open its pad</span></div><div class="project-cards notes-cards"><button class="project-card notes-card"><span class="project-card-head"><span class="pdot" style="background:#f97316"></span><span class="project-card-name"><span>🏡 </span>Hall</span><span class="project-card-pct">5 words · 1 photo</span></span><span class="notes-card-preview">Paint Sage for the hall</span></button><button class="project-card notes-card"><span class="project-card-head"><span class="pdot" style="background:#f97316"></span><span class="project-card-name">Garden</span><span class="project-card-pct">2 words</span></span><span class="notes-card-preview">Beds tomatoes</span></button><button class="project-card notes-card"><span class="project-card-head"><span class="pdot" style="background:#f97316"></span><span class="project-card-name">Garage</span><span class="project-card-pct">empty</span></span><span class="project-card-sub">No notes yet — click to start.</span></button></div></div>"`)
  })

  it('renders the empty hero exactly as before', () => {
    expect(renderToStaticMarkup(<NotesView projects={[]} {...legacy} />)).toMatchInlineSnapshot(`"<div class="empty-hero"><h2>Notes live inside projects</h2><p>Create a project and its notepad appears here: brainstorm with headings, lists, checklists, links, code, emoji and photos dropped straight in.</p><p><button class="btn primary">+ New project</button></p></div>"`)
  })

  it('renders a project pad exactly as before', () => {
    expect(renderToStaticMarkup(<NotesView projects={PROJECTS} project={PROJECTS[0]} {...legacy} />)).toMatchInlineSnapshot(`"<div class="notes-page"><header class="notes-page-head"><button type="button" class="btn subtle notes-back">All notes</button><h2 class="view-title"><span class="pdot" style="background:#f97316"></span> 🏡 Hall · Notes</h2></header><div class="notes"><div class="notes-toolbar"><button type="button" class="btn subtle notes-tool" title="Bold (Cmd/Ctrl+B)">B</button><button type="button" class="btn subtle notes-tool" title="Italic (Cmd/Ctrl+I)">I</button><button type="button" class="btn subtle notes-tool" title="Underline (Cmd/Ctrl+U)">U</button><button type="button" class="btn subtle notes-tool" title="Strikethrough">S</button><button type="button" class="btn subtle notes-tool" title="Heading">H</button><button type="button" class="btn subtle notes-tool" title="Normal text">¶</button><button type="button" class="btn subtle notes-tool" title="Bullet list">•</button><button type="button" class="btn subtle notes-tool" title="Numbered list">1.</button><button type="button" class="btn subtle notes-tool" title="Checklist">☐</button><button type="button" class="btn subtle notes-tool" title="Quote">“</button><button type="button" class="btn subtle notes-tool" title="Inline code">&lt;&gt;</button><button type="button" class="btn subtle notes-tool" title="Code block">{ }</button><button type="button" class="btn subtle notes-tool" title="Link (Cmd/Ctrl+K)">🔗</button><button type="button" class="btn subtle notes-tool" title="Divider">―</button><span class="notes-emoji-wrap"><button type="button" class="btn subtle notes-tool" title="Emoji (Ctrl+Cmd+Space / Win+. also works)">😀</button></span><button type="button" class="btn subtle notes-tool notes-to-task" title="Turn the selected text (or the line you&#x27;re on) into a task">☐ Task</button><label class="btn subtle notes-tool" title="Add photos (or paste / drop them anywhere in the note)">📷<input type="file" accept="image/*" multiple="" hidden=""/></label></div><div class="notes-editable md" contenteditable="true" spellcheck="true" data-placeholder="Start typing. Paste or drop photos right here. Bold, lists, checklists, links, code and emoji from the bar above."></div><div class="notes-foot"><small>5 words · Cmd/Ctrl+click a link to open it</small><span class="spacer"></span><small>Autosaves as you type</small></div></div></div>"`)
  })
})
