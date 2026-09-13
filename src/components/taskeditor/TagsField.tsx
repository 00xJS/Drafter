import { AiBusy, SetForm, TaskForm } from '../../taskform'

interface Props {
  form: Pick<TaskForm, 'tags' | 'title' | 'description'>
  set: SetForm
  aiBusy: AiBusy
  onSuggestTags(): void
}

/** Tags, comma-separated, with ✨ suggestions from the title and description. */
export function TagsField({ form, set, aiBusy, onSuggestTags }: Props) {
  const { tags, title, description } = form
  return (
    <label className="field tags-field">
      <span>
        Tags <small>(comma-separated)</small>
      </span>
      <input value={tags} onChange={e => set({ tags: e.target.value })} placeholder="home, errand" />
      <button type="button" className="btn subtle ai-inline" disabled={(!description.trim() && !title.trim()) || aiBusy !== null} onClick={onSuggestTags}>
        {aiBusy === 'tags' ? 'Suggesting…' : '✨ Suggest tags'}
      </button>
    </label>
  )
}
