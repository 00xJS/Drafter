import { Component, ReactNode } from 'react'
import { reportRenderError } from '../errorreport'

interface Props {
  children: ReactNode
  /** Shown in the message so the user knows which part failed. */
  where?: string
  /** Changing this value clears the error (e.g. switching tabs). Compared as it is, so a record or a string alike. */
  resetKey?: unknown
  /** What to draw instead of the full-page message: a card's own line, a bar's, or nothing. `retry` draws the children again. */
  fallback?: (error: Error, retry: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * Without this, one uncaught render error unmounts the entire app and leaves a
 * blank page — the user cannot even navigate away, and unsaved work is lost.
 * Anything inside a boundary degrades to a message with a way out instead,
 * and the site owner hears of it (src/errorreport.ts), under the boundary's
 * `where` — a name the code gives it, never anything on the page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  componentDidCatch(error: Error) {
    console.error('Drafter caught a render error:', error)
    reportRenderError(error, this.props.where)
  }

  retry = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback) return this.props.fallback(this.state.error, this.retry)
    return (
      <div className="empty-hero error-hero">
        <h2>Something broke{this.props.where ? ` in ${this.props.where}` : ''}</h2>
        <p>Your data is safe — this is only the view. Switch tabs to carry on, or reload if it keeps happening.</p>
        <p className="error-detail">{this.state.error.message}</p>
        <p>
          <button className="btn" onClick={this.retry}>
            Try again
          </button>{' '}
          <button className="btn subtle" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      </div>
    )
  }
}

/**
 * One card of a screen that draws several (Home): a card that fails says so
 * in its own place, and the cards around it carry on. All of Home was one
 * boundary, so one bad card took the whole day with it.
 */
export function CardBoundary({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary
      where={name}
      fallback={(error, retry) => (
        <section className="chart-card" role="alert">
          <p className="warn">Something broke in {name}. The rest of the page carries on, and your data is safe.</p>
          <p className="error-detail">{error.message}</p>
          <p>
            <button type="button" className="btn subtle" onClick={retry}>
              Try again
            </button>
          </p>
        </section>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/**
 * The root, around the whole app: what no boundary of its own caught — the
 * sign-in gate, the planner's frame — ends here rather than in a blank page,
 * and is reported like any other. There is no screen to go back to at this
 * level, so the way on is a reload.
 */
export function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      where="the app"
      fallback={error => (
        <div className="empty-hero error-hero" role="alert">
          <h2>Something went wrong</h2>
          <p>Your data is safe on this device. Reload to carry on.</p>
          <p className="error-detail">{error.message}</p>
          <p>
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </p>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
