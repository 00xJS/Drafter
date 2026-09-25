// The task editor's three ✨ rewrites of a description, as its buttons name
// them. The buttons draw these with the editor; the rewrite itself (ai.ts,
// the assistant's code) loads on the first tap, not with the editor, which
// the app warms at launch.

export type RefineMode = 'clarify' | 'expand' | 'summarize'

export const REFINE_META: Record<RefineMode, { label: string; busy: string; hint: string }> = {
  clarify: { label: '✨ Clarify', busy: 'Clarifying…', hint: 'Rewrite for clarity, same facts' },
  expand: { label: '✨ Add details', busy: 'Expanding…', hint: 'Fill in steps, specifics and open questions' },
  summarize: { label: '✨ Summarize', busy: 'Summarizing…', hint: 'Condense to the essentials' },
}
