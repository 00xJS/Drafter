import { useState } from 'react'
import { createIssue, parseGithubUrl } from '../../github'
import { openExternal } from '../../native'
import { AiBusy, SetForm, TaskForm, Unlinked, cardUrl, descriptionLinks, linkLabel, relinkGithub, unlinkGithub } from '../../taskform'
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
 * as a chip that opens in a new tab, or Safari's sheet on the phone. Unlink
 * takes the address out of the description too, or the save would link it
 * again, and offers an Undo that puts both back.
 */
export function DescriptionLinks({ form, set, project, aiBusy, setAiError }: Props) {
  const { githubUrl, title, description } = form
  // what Unlink took off, while its Undo is offered: a link set again since
  // (the Undo itself, or a new issue) retires it
  const [unlinked, setUnlinked] = useState<Unlinked | null>(null)
  const undo = unlinked && !githubUrl.trim() ? unlinked : null
  const card = cardUrl(form)
  const links = descriptionLinks(description, card)
  const repo = !card && project?.githubUrl ? parseGithubUrl(project.githubUrl)?.repo : undefined
  if (!card && !repo && links.length === 0 && !undo) return null

  const unlink = () => {
    const { patch, unlinked } = unlinkGithub(form)
    setUnlinked(unlinked)
    set(patch)
  }

  return (
    <div className="desc-links">
      {card && <GithubCard url={card} onUnlink={githubUrl.trim() ? unlink : undefined} />}
      {undo && (
        <p className="field-hint">
          Unlinked {linkLabel(undo.url)}, from the task and its description.{' '}
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              set(f => relinkGithub(f, undo))
              setUnlinked(null)
            }}
          >
            Undo
          </button>
        </p>
      )}
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
