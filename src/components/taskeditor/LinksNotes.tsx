import { createIssue, parseGithubUrl } from '../../github'
import { AiBusy, SetForm, TaskForm } from '../../taskform'
import { Project } from '../../types'
import { GithubCard } from '../GithubCard'

interface Props {
  form: Pick<TaskForm, 'githubUrl' | 'link' | 'notes' | 'title' | 'description'>
  set: SetForm
  /** The task's project: a new GitHub issue goes to its repo. */
  project: Project | undefined
  aiBusy: AiBusy
  setAiError(message: string): void
}

/** The GitHub card (or a button to open an issue), the link, and private notes. */
export function LinksNotes({ form, set, project, aiBusy, setAiError }: Props) {
  const { githubUrl, link, notes, title, description } = form
  return (
    <>
      <label className="field">
        <span>GitHub</span>
        <input value={githubUrl} onChange={e => set({ githubUrl: e.target.value })} placeholder="Issue, PR, repo or project URL" />
      </label>
      {githubUrl.trim() && <GithubCard url={githubUrl.trim()} />}
      {!githubUrl.trim() && project?.githubUrl && parseGithubUrl(project.githubUrl)?.repo && (
        <button
          type="button"
          className="btn subtle ai-inline"
          disabled={!title.trim() || aiBusy !== null}
          onClick={async () => {
            setAiError('')
            try {
              const issue = await createIssue(project.githubUrl!, title.trim(), description.trim())
              set({ githubUrl: issue.url })
            } catch (e) {
              setAiError((e as Error).message)
            }
          }}
        >
          Create a GitHub issue in {parseGithubUrl(project.githubUrl)!.repo}
        </button>
      )}

      <label className="field">
        <span>Link</span>
        <input value={link} onChange={e => set({ link: e.target.value })} placeholder="https://…" />
      </label>

      <label className="field">
        <span>Notes</span>
        <textarea rows={2} value={notes} onChange={e => set({ notes: e.target.value })} placeholder="Private scratch space" />
      </label>
    </>
  )
}
