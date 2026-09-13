import { createIssue, parseGithubUrl } from '../../github'
import { openExternal } from '../../native'
import { AiBusy, SetForm, TaskForm, cardUrl, descriptionLinks, linkLabel } from '../../taskform'
import { Project } from '../../types'
import { GithubCard } from '../GithubCard'

interface Props {
  form: Pick<TaskForm, 'githubUrl' | 'title' | 'description'>
  set: SetForm
  /** The task's project: a new GitHub issue goes to its repo. */
  project: Project | undefined
  aiBusy: AiBusy
  setAiError(message: string): void
}

/**
 * Under the description, what it links to: the live GitHub card for the task's
 * issue (its own githubUrl, or the first GitHub URL in the text — a save links
 * that one), a button to open an issue when there is none, and every other URL
 * as a chip that opens in a new tab, or Safari's sheet on the phone.
 */
export function DescriptionLinks({ form, set, project, aiBusy, setAiError }: Props) {
  const { githubUrl, title, description } = form
  const card = cardUrl(form)
  const links = descriptionLinks(description, card)
  const repo = !card && project?.githubUrl ? parseGithubUrl(project.githubUrl)?.repo : undefined
  if (!card && !repo && links.length === 0) return null

  return (
    <div className="desc-links">
      {card && <GithubCard url={card} onUnlink={githubUrl.trim() ? () => set({ githubUrl: '' }) : undefined} />}
      {repo && (
        <button
          type="button"
          className="btn subtle ai-inline"
          disabled={!title.trim() || aiBusy !== null}
          onClick={async () => {
            setAiError('')
            try {
              const issue = await createIssue(project!.githubUrl!, title.trim(), description.trim())
              set({ githubUrl: issue.url })
            } catch (e) {
              setAiError((e as Error).message)
            }
          }}
        >
          Create a GitHub issue in {repo}
        </button>
      )}
      {links.length > 0 && (
        <div className="link-chips">
          {links.map(url => (
            <a
              key={url}
              className="link-chip"
              href={url}
              target="_blank"
              rel="noreferrer"
              title={url}
              onClick={e => {
                e.preventDefault()
                void openExternal(url)
              }}
            >
              <span aria-hidden>↗</span>
              <span className="link-chip-text">{linkLabel(url)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
