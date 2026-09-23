import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/*
 * Most tests run in node with no DOM, so a component with hooks cannot be
 * clicked there (a *.dom.test.tsx runs in a document and can: dom.ts). It can
 * be called, though, inside a server render: its hooks are
 * then that render's own, and what it returns is a tree of elements holding
 * the real handlers. These helpers call a component that way and press what
 * it returns, as place-kind.test.tsx presses the hook-free ones. A component
 * in the tree is listed, never called, so its own hooks are no concern here.
 */

type Props = Record<string, unknown> & { children?: ReactNode }
export type El = ReactElement<Props>

/**
 * The trees a component returns, called inside a server render so its hooks
 * run. `act`, run once on the first tree while the render is still going, may
 * press or type there: React applies what that sets and calls the component
 * again, so the last tree is the component after it. A press once the render
 * is over only calls the props the component was handed, since on the server
 * state set then goes nowhere.
 */
export function rendered<P>(Component: (props: P) => ReactNode, props: P, act?: (tree: ReactNode) => void): ReactNode[] {
  const trees: ReactNode[] = []
  function Probe() {
    const tree = Component(props)
    trees.push(tree)
    if (trees.length === 1) act?.(tree)
    return null
  }
  renderToStaticMarkup(<Probe />)
  return trees
}

/** The last tree `rendered` gives: the component as it stands after `act`. */
export function settled<P>(Component: (props: P) => ReactNode, props: P, act?: (tree: ReactNode) => void): ReactNode {
  const trees = rendered(Component, props, act)
  return trees[trees.length - 1]
}

/** Every element in a tree, host and component alike, in document order. */
export function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const el = node as El
  return [el, ...elements(el.props.children)]
}

/** The words inside a node, run together as a reader would hear them. */
export function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as El).props.children)
  return ''
}

/** The props of the one component of this type in the tree: what it was handed, its callbacks among them. */
export function propsOf<P>(tree: ReactNode, type: (props: P) => ReactNode): P {
  const hit = elements(tree).find(e => e.type === type)
  if (!hit) throw new Error(`no ${type.name} in the tree`)
  return hit.props as P
}

/** The button called `name`, by its aria-label or its words. */
export function button(tree: ReactNode, name: string): El {
  const hit = elements(tree).find(e => e.type === 'button' && (e.props['aria-label'] === name || textOf(e.props.children).replace(/\s+/g, ' ').trim() === name))
  if (!hit) throw new Error(`no ${name} button`)
  return hit
}

/** Press the button called `name` through its onClick. */
export const press = (tree: ReactNode, name: string): void => (button(tree, name).props.onClick as () => void)()

/** Type into the field `which` picks out: its onChange, handed what a keystroke's event would carry. */
export function typeInto(tree: ReactNode, which: (props: Record<string, unknown>) => boolean, value: string): void {
  const hit = elements(tree).find(e => (e.type === 'input' || e.type === 'textarea') && which(e.props))
  if (!hit) throw new Error('no such field')
  ;(hit.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } })
}
