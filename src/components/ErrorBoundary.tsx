import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown in the message so the user knows which part failed. */
  where?: string
  /** Changing this value clears the error (e.g. switching tabs). */
  resetKey?: string
}

interface State {
  error: Error | null
}

/**
 * Without this, one uncaught render error unmounts the entire app and leaves a
 * blank page — the user cannot even navigate away, and unsaved work is lost.
 * Anything inside a boundary degrades to a message with a way out instead.
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
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty-hero error-hero">
        <h2>Something broke{this.props.where ? ` in ${this.props.where}` : ''}</h2>
        <p>Your data is safe — this is only the view. Switch tabs to carry on, or reload if it keeps happening.</p>
        <p className="error-detail">{this.state.error.message}</p>
        <p>
          <button className="btn" onClick={() => this.setState({ error: null })}>
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
